import type { RunEvent } from '../host/types'

// Pure mapping of app-server notifications onto the host's RunEvents, per thread. Keeps the small state a stream needs
// (delta bookkeeping per item, command output buffers) and nothing else; the host owns turns, prompts and usage.

export type TokenBreakdown = { totalTokens: number; inputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number; outputTokens: number; reasoningOutputTokens: number }

export type MappedTurnEnd = { status: 'completed' | 'interrupted' | 'failed' | 'inProgress'; error: string | null; turnId: string; finalText: string; allText: string }

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const MAX_OUTPUT = 32_000

export class CodexEventMapper {
  private textSeen = new Map<string, number>() // agentMessage / plan item id → chars already emitted as deltas
  private reasoning = new Map<string, string>()
  private cmdOutput = new Map<string, string>()
  private fileChanges = new Map<string, string[]>()
  private finalTexts: string[] = []
  private finalAnswer: string | null = null // the agentMessage Codex marks as the answer (structured output lives here)
  lastUsage: { total: TokenBreakdown; last: TokenBreakdown; contextWindow: number | null } | null = null

  resetTurn(): void {
    this.textSeen.clear(); this.reasoning.clear(); this.cmdOutput.clear(); this.fileChanges.clear(); this.finalTexts = []; this.finalAnswer = null
  }

  // Paths touched by a fileChange item (for the approval card before the item completes).
  pathsOf(itemId: string): string[] { return this.fileChanges.get(itemId) ?? [] }

  // Returns the events to emit plus, for turn/completed, the turn outcome.
  map(method: string, p: any): { events: RunEvent[]; turnEnd?: MappedTurnEnd; command?: { id: string; command: string; exitCode: number | null; status: string } } {
    const ev: RunEvent[] = []
    switch (method) {
      case 'item/agentMessage/delta':
      case 'item/plan/delta': {
        const d = String(p.delta ?? '')
        if (d) { this.textSeen.set(p.itemId, (this.textSeen.get(p.itemId) ?? 0) + d.length); ev.push({ t: 'text_delta', text: d, parent: null }) }
        break
      }
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
        this.reasoning.set(p.itemId, ((this.reasoning.get(p.itemId) ?? '') + String(p.delta ?? '')).slice(-8000))
        break
      case 'item/commandExecution/outputDelta':
        this.cmdOutput.set(p.itemId, ((this.cmdOutput.get(p.itemId) ?? '') + String(p.delta ?? '')).slice(-MAX_OUTPUT))
        break
      case 'item/started': {
        const it = p.item ?? {}
        if (it.type === 'commandExecution') ev.push({ t: 'tool_use', id: it.id, name: 'Bash', input: { command: String(it.command ?? ''), cwd: it.cwd ?? undefined }, parent: null })
        else if (it.type === 'fileChange') {
          const paths = (it.changes ?? []).map((c: any) => String(c.path ?? ''))
          this.fileChanges.set(it.id, paths)
          ev.push({ t: 'tool_use', id: it.id, name: 'ApplyPatch', input: { file_path: paths.join(', '), diff: (it.changes ?? []).map((c: any) => c.diff ?? '').join('\n').slice(0, MAX_OUTPUT) }, parent: null })
        }
        else if (it.type === 'mcpToolCall') ev.push({ t: 'tool_use', id: it.id, name: `mcp__${it.server}__${it.tool}`, input: it.arguments ?? {}, parent: null })
        else if (it.type === 'webSearch') ev.push({ t: 'tool_use', id: it.id, name: 'WebSearch', input: { query: it.query ?? it.action?.query ?? '' }, parent: null })
        else if (it.type === 'dynamicToolCall') ev.push({ t: 'tool_use', id: it.id, name: it.namespace ? `${it.namespace}.${it.tool}` : String(it.tool), input: it.arguments ?? {}, parent: null })
        else if (it.type === 'subAgentActivity' || it.type === 'collabAgentToolCall') ev.push({ t: 'task', status: 'started', taskId: String(it.agentThreadId ?? it.id), summary: it.prompt ?? it.kind ?? undefined })
        break
      }
      case 'item/completed': {
        const it = p.item ?? {}
        let command: { id: string; command: string; exitCode: number | null; status: string } | undefined
        if (it.type === 'agentMessage' || it.type === 'plan') {
          const text = String(it.text ?? '')
          const seen = this.textSeen.get(it.id) ?? 0
          if (text.length > seen) ev.push({ t: 'text_delta', text: text.slice(seen), parent: null })
          this.textSeen.set(it.id, text.length)
          if (text) { ev.push({ t: 'assistant_text', text, uuid: String(it.id), parent: null }); this.finalTexts.push(text); if (it.phase === 'final_answer' || it.type === 'plan') this.finalAnswer = text }
        } else if (it.type === 'reasoning') {
          const text = [...(it.summary ?? []), ...(it.content ?? [])].filter(Boolean).join('\n') || this.reasoning.get(it.id) || ''
          if (text.trim()) ev.push({ t: 'thinking', text, parent: null })
          this.reasoning.delete(it.id)
        } else if (it.type === 'commandExecution') {
          const output = String(it.aggregatedOutput ?? this.cmdOutput.get(it.id) ?? '').slice(-MAX_OUTPUT)
          const failed = it.status === 'failed' || it.status === 'declined' || (typeof it.exitCode === 'number' && it.exitCode !== 0)
          ev.push({ t: 'tool_result', id: it.id, output: output || (it.status === 'declined' ? 'declined' : `exit ${it.exitCode ?? '?'}`), isError: failed, parent: null })
          this.cmdOutput.delete(it.id)
          command = { id: it.id, command: String(it.command ?? ''), exitCode: typeof it.exitCode === 'number' ? it.exitCode : null, status: String(it.status ?? '') }
        } else if (it.type === 'fileChange') {
          const paths = (it.changes ?? []).map((c: any) => String(c.path ?? ''))
          ev.push({ t: 'tool_result', id: it.id, output: `${it.status}: ${paths.join(', ')}`, isError: it.status === 'failed' || it.status === 'declined', parent: null })
          this.fileChanges.delete(it.id)
        } else if (it.type === 'mcpToolCall') {
          const out = it.error ? String(it.error.message ?? JSON.stringify(it.error)) : JSON.stringify(it.result ?? null)
          ev.push({ t: 'tool_result', id: it.id, output: String(out).slice(0, MAX_OUTPUT), isError: !!it.error || it.status === 'failed', parent: null })
        } else if (it.type === 'webSearch') {
          ev.push({ t: 'tool_result', id: it.id, output: 'done', isError: false, parent: null })
        } else if (it.type === 'dynamicToolCall') {
          ev.push({ t: 'tool_result', id: it.id, output: JSON.stringify(it.contentItems ?? null).slice(0, MAX_OUTPUT), isError: it.success === false || it.status === 'failed', parent: null })
        } else if (it.type === 'subAgentActivity' || it.type === 'collabAgentToolCall') {
          ev.push({ t: 'task', status: it.status === 'failed' ? 'failed' : 'completed', taskId: String(it.agentThreadId ?? it.id) })
        } else if (it.type === 'contextCompaction') {
          ev.push({ t: 'compaction', trigger: 'auto', preTokens: this.lastUsage?.last.totalTokens ?? 0 })
        }
        return { events: ev, command }
      }
      case 'thread/tokenUsage/updated': {
        const u = p.tokenUsage ?? {}
        const br = (x: any): TokenBreakdown => ({ totalTokens: num(x?.totalTokens), inputTokens: num(x?.inputTokens), cachedInputTokens: num(x?.cachedInputTokens), cacheWriteInputTokens: num(x?.cacheWriteInputTokens), outputTokens: num(x?.outputTokens), reasoningOutputTokens: num(x?.reasoningOutputTokens) })
        this.lastUsage = { total: br(u.total), last: br(u.last), contextWindow: typeof u.modelContextWindow === 'number' ? u.modelContextWindow : null }
        if (this.lastUsage.contextWindow) {
          const used = this.lastUsage.last.totalTokens
          ev.push({ t: 'context', totalTokens: used, maxTokens: this.lastUsage.contextWindow, percentage: Math.min(100, Math.round((used / this.lastUsage.contextWindow) * 100)) })
        }
        break
      }
      case 'thread/compacted':
        ev.push({ t: 'compaction', trigger: 'manual', preTokens: this.lastUsage?.last.totalTokens ?? 0 })
        break
      case 'thread/status/changed': {
        const st = p.status ?? {}
        if (st.type === 'active' && Array.isArray(st.activeFlags) && st.activeFlags.length) ev.push({ t: 'status', status: 'waiting_prompt' })
        else if (st.type === 'active') ev.push({ t: 'status', status: 'busy' })
        break
      }
      case 'turn/plan/updated': {
        const steps = Array.isArray(p.plan) ? p.plan.map((s: any) => `${s.status === 'completed' ? '✓' : s.status === 'inProgress' ? '▸' : '·'} ${s.step}`).join('\n') : ''
        if (steps) ev.push({ t: 'note', text: `plan:\n${steps}` })
        break
      }
      case 'turn/diff/updated':
        break // the fix/feature panels compute their own diff from the worktree
      case 'error': {
        const msg = String(p.error?.message ?? 'error')
        ev.push({ t: 'error', message: p.willRetry ? `retrying: ${msg}` : msg })
        break
      }
      case 'warning': case 'configWarning': case 'deprecationNotice': case 'guardianWarning':
        ev.push({ t: 'note', text: `${method}: ${String(p.message ?? p.warning ?? JSON.stringify(p)).slice(0, 500)}` })
        break
      case 'model/rerouted':
        ev.push({ t: 'note', text: `model rerouted: ${String(p.fromModel ?? '?')} → ${String(p.toModel ?? '?')}` })
        break
      case 'hook/started':
        ev.push({ t: 'note', text: `hook ${String(p.run?.eventName ?? '')} started (${String(p.run?.sourcePath ?? '').split('/').slice(-3).join('/')})` })
        break
      case 'turn/completed': {
        const turn = p.turn ?? {}
        const status = (turn.status ?? 'completed') as MappedTurnEnd['status']
        const error = turn.error ? String(turn.error.message ?? 'turn failed') : null
        return { events: ev, turnEnd: { status, error, turnId: String(turn.id ?? ''), finalText: this.finalAnswer ?? this.finalTexts[this.finalTexts.length - 1] ?? '', allText: this.finalTexts.join('\n\n') } }
      }
      default:
        break
    }
    return { events: ev }
  }
}

// Per-turn token delta from two cumulative thread snapshots.
export function diffBreakdown(prev: TokenBreakdown | null, next: TokenBreakdown): TokenBreakdown {
  if (!prev) return next
  const d = (a: number, b: number) => (a - b < 0 ? a : a - b)
  return {
    totalTokens: d(next.totalTokens, prev.totalTokens), inputTokens: d(next.inputTokens, prev.inputTokens), cachedInputTokens: d(next.cachedInputTokens, prev.cachedInputTokens),
    cacheWriteInputTokens: d(next.cacheWriteInputTokens, prev.cacheWriteInputTokens), outputTokens: d(next.outputTokens, prev.outputTokens), reasoningOutputTokens: d(next.reasoningOutputTokens, prev.reasoningOutputTokens),
  }
}

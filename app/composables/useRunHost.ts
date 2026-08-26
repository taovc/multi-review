// Session-host client state shared by every chat surface (global drawer, fix panel): pending prompts, live status, mode,
// context meter, per-turn cost, and the answer/mode calls against /api/runs/:id. The caller feeds RunEvents from its SSE.
export type Pending = { id: string; kind: 'tool' | 'question' | 'plan'; toolName: string; input: any; suggestions: boolean; title: string | null; description: string | null; createdAt: string }
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'
export const PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions']
export type HostInfo = { live: string; permissionMode: string | null; allowDanger: boolean | null; commands: string[]; skills: string[]; model: string | null }
export type RunSummary = { costUsd: number | null; costSource: string | null; inputTokens: number; outputTokens: number; numTurns: number } | null

export function useRunHost(runId: Ref<string | null>, opts: { pushLog: (line: string) => void; notify: (msg: string) => void }) {
  const { t } = useI18n()
  const pending = ref<Pending[]>([])
  const liveStatus = ref<string>('closed')
  const hostCommands = ref<string[]>([])
  const hostCommandEntries = ref<Array<{ name: string; description: string; argumentHint: string; aliases?: string[] }>>([]) // full entries from a commands_changed push
  const contextUse = ref<{ pct: number; total: number; max: number } | null>(null)
  const lastTurnCost = ref<number | null>(null)
  const sessionCost = ref<number | null>(null)
  const mode = ref<PermissionMode>('default')
  const busy = ref(false)
  const denyNote = ref<Record<string, string>>({})
  const otherAnswer = ref<Record<string, string>>({})
  const questionPick = ref<Record<string, Record<string, string | string[]>>>({})
  const denying = ref<string | null>(null)

  function reset() {
    pending.value = []; liveStatus.value = 'closed'; hostCommands.value = []; contextUse.value = null
    lastTurnCost.value = null; sessionCost.value = null; denying.value = null
  }
  // Apply the server snapshot from a GET (host info + pending prompts + run row).
  function applyDetail(d: { host?: HostInfo; pending?: Pending[]; run?: RunSummary }) {
    pending.value = d.pending ?? []
    if (d.host) {
      liveStatus.value = d.host.live
      hostCommands.value = d.host.commands ?? []
      if (d.host.permissionMode && PERMISSION_MODES.includes(d.host.permissionMode as PermissionMode)) mode.value = d.host.permissionMode as PermissionMode
    }
    sessionCost.value = d.run?.costUsd ?? null
  }
  function onRunEvent(ev: any) {
    switch (ev.t) {
      case 'init': hostCommands.value = ev.slashCommands ?? []; break
      case 'commands': hostCommands.value = (ev.commands ?? []).map((c: any) => c.name); hostCommandEntries.value = ev.commands ?? []; break
      case 'status': liveStatus.value = ev.status; break
      case 'mode': if (PERMISSION_MODES.includes(ev.permissionMode)) mode.value = ev.permissionMode; break
      case 'tool_use': {
        const i = ev.input ?? {}
        const v = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.description ?? i.prompt ?? ''
        opts.pushLog(`${ev.parent ? '  ' : ''}${ev.name} ${String(v).slice(0, 160)}`)
        break
      }
      case 'tool_result': opts.pushLog(`${ev.parent ? '  ' : ''}↳ ${ev.isError ? '✗' : '✓'} ${String(ev.output || '').replace(/\s+/g, ' ').slice(0, 160)}`); break
      case 'thinking': opts.pushLog(`💭 ${t('global.thinking')} (${String(ev.text || '').length})`); break
      case 'task': opts.pushLog(`⧉ subagent ${ev.status}${ev.summary ? ': ' + String(ev.summary).slice(0, 120) : ''}`); break
      case 'permission_request':
        pending.value = [...pending.value.filter((p) => p.id !== ev.promptId), { id: ev.promptId, kind: ev.kind, toolName: ev.toolName, input: ev.input, suggestions: !!ev.suggestions, title: ev.title ?? null, description: ev.description ?? null, createdAt: new Date().toISOString() }]
        opts.pushLog(`? ${ev.kind} ${ev.toolName}`)
        break
      case 'permission_resolved':
        pending.value = pending.value.filter((p) => p.id !== ev.promptId)
        if (ev.status === 'expired' || ev.status === 'cancelled') opts.pushLog(`permission ${ev.status}`)
        break
      case 'permission_denied': opts.pushLog(`⛔ ${ev.toolName}: ${String(ev.message || '').slice(0, 120)}`); break
      case 'compaction': opts.pushLog(t('global.compacted', { pre: ev.preTokens, post: ev.postTokens ?? '?' })); break
      case 'context': contextUse.value = { pct: ev.percentage, total: ev.totalTokens, max: ev.maxTokens }; break
      case 'turn_done':
        lastTurnCost.value = ev.costUsd ?? null
        if (ev.costUsd != null) sessionCost.value = (sessionCost.value ?? 0) + ev.costUsd
        break
      case 'error': opts.pushLog(`✗ ${String(ev.message || '').slice(0, 200)}`); break
      case 'note': opts.pushLog(String(ev.text || '').slice(0, 200)); break
      default: break
    }
  }

  // ── prompt helpers ──
  function promptPreview(p: Pending): string {
    const i = p.input ?? {}
    if (p.kind === 'plan') return ''
    const cap = (s: unknown, n = 2000) => { const s2 = String(s ?? ''); return s2.length > n ? `${s2.slice(0, n)}\n… (${s2.length - n} more chars)` : s2 }
    // Approving must not be blind: show what a write would put on disk / what an edit replaces.
    if (p.toolName === 'Write') return `${i.file_path}\n────────\n${cap(i.content)}`
    if (p.toolName === 'Edit') return `${i.file_path}\n──── old ────\n${cap(i.old_string, 1200)}\n──── new ────\n${cap(i.new_string, 1200)}`
    if (p.toolName === 'MultiEdit' && Array.isArray(i.edits)) return `${i.file_path}\n${i.edits.map((e: any, k: number) => `#${k + 1} ${cap(e.old_string, 300)} → ${cap(e.new_string, 300)}`).join('\n')}`
    const v = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.url ?? i.query ?? ''
    if (v) return cap(v, 1200)
    try { return cap(JSON.stringify(i, null, 1), 1200) } catch { return '' }
  }
  function planText(p: Pending): string { const i = p.input ?? {}; return String(i.plan ?? i.content ?? i.summary ?? '') }
  async function answerPrompt(p: Pending, body: any) {
    if (!runId.value) return
    busy.value = true
    try {
      await $fetch(`/api/runs/${runId.value}/prompts/${p.id}`, { method: 'POST', body })
      pending.value = pending.value.filter((x) => x.id !== p.id)
    } catch (e: any) {
      opts.notify(e?.data?.statusMessage || t('common.failed'))
      if (e?.statusCode === 409 || e?.data?.statusCode === 409) pending.value = pending.value.filter((x) => x.id !== p.id)
    } finally { busy.value = false }
  }
  function pickOption(p: Pending, question: string, label: string, multi: boolean) {
    const cur = questionPick.value[p.id] ?? {}
    if (multi) {
      const arr = Array.isArray(cur[question]) ? [...(cur[question] as string[])] : []
      const idx = arr.indexOf(label)
      if (idx >= 0) arr.splice(idx, 1); else arr.push(label)
      cur[question] = arr
    } else cur[question] = label
    questionPick.value = { ...questionPick.value, [p.id]: cur }
  }
  function isPicked(p: Pending, question: string, label: string): boolean {
    const v = questionPick.value[p.id]?.[question]
    return Array.isArray(v) ? v.includes(label) : v === label
  }
  function submitQuestion(p: Pending) {
    const qs: any[] = p.input?.questions ?? []
    const answers: Record<string, string | string[]> = {}
    for (const q of qs) {
      const picked = questionPick.value[p.id]?.[q.question]
      const other = (otherAnswer.value[`${p.id}:${q.question}`] || '').trim()
      if (other) answers[q.question] = other
      else if (picked !== undefined && (!Array.isArray(picked) || picked.length)) answers[q.question] = picked
    }
    if (!Object.keys(answers).length) return
    void answerPrompt(p, { behavior: 'answer', answers })
  }
  function questionReady(p: Pending): boolean {
    const qs: any[] = p.input?.questions ?? []
    return qs.some((q) => (otherAnswer.value[`${p.id}:${q.question}`] || '').trim() || questionPick.value[p.id]?.[q.question] !== undefined)
  }
  // Mode: applied to the live query immediately when there is one; otherwise it rides along with the next message.
  async function setMode(m: PermissionMode) {
    mode.value = m
    if (!runId.value) return
    await $fetch(`/api/runs/${runId.value}/mode`, { method: 'POST', body: { permissionMode: m } }).catch(() => {})
  }
  async function setAllowDanger(v: boolean) {
    if (!runId.value) return
    await $fetch(`/api/runs/${runId.value}/mode`, { method: 'POST', body: { allowDanger: v } }).catch(() => {})
  }

  return { pending, liveStatus, hostCommands, hostCommandEntries, contextUse, lastTurnCost, sessionCost, mode, busy, denyNote, otherAnswer, denying, reset, applyDetail, onRunEvent, promptPreview, planText, answerPrompt, pickOption, isPicked, submitQuestion, questionReady, setMode, setAllowDanger }
}
export type RunHost = ReturnType<typeof useRunHost>

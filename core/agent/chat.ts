import { runClaudeStream } from './claudeCli'
import { dangerSettingsJson, dangerEnv } from './dangerGuard'
import { langName } from './lang'
import { RECOMMENDED_MARKER } from './decisionCard'
import type { ChildProcess } from 'node:child_process'

// The claude runner + shared capability fragments used by all three chats (feature development / main assistant Global / fix a PR).
// Unified: bypassPermissions + dangerous-command guard (dangerGuard) + ultracode background injection + stream-json event parsing +
// the "decision card" convention (ask-user block). The three differ only in systemPrompt (their own methodology), cwd, and "turn wrap-up" (each pipeline handles its own).
// — Image reading (issue/PR private attachments) all goes through fetchIssueContext in core/github/issueAssets (each pipeline calls it while building the message).

export type AgentChatCallbacks = {
  onSpawn?: (cp: ChildProcess) => void
  onSessionId?: (sessionId: string) => void
  onText?: (text: string) => void
  onTool?: (name: string, info: string) => void
}

export type AgentChatOptions = AgentChatCallbacks & {
  cwd: string
  model: string
  effort?: string
  sessionId: string | null // present → --resume
  message: string // the clean user message (image enrichment is assembled by the caller beforehand; the ultracode prefix is injected by this runner per the flag)
  historyAccess?: string
  systemPrompt: string // each chat's methodology (includes askUserClause) → --append-system-prompt
  allowDanger?: boolean // let dangerous commands through the guard (including git push / gh pr create)
  ultracode?: boolean // background activation → inject an `ultracode:` prefix into the message sent to the agent (what is stored/displayed stays the clean message)
}

export type AgentChatResult = { costUsd: number; sessionId: string | null; text: string }

// Decision-card convention (identical across all three): on a genuine fork, emit one ```ask-user fenced block and end the turn; the frontend parses it into a decision card (clicking an option = the next message, resuming the session).
// This block is concatenated into each chat's systemPrompt. Both claude and codex use it, with identical behavior.
export function askUserClause(lang: string): string {
  return `When you hit a GENUINE decision point — a real fork such as architecture, data model, an external contract, or a user-facing tradeoff — STOP and emit EXACTLY one fenced block, then END your turn and wait (the user's answer arrives as the next message):
\`\`\`ask-user
<your question in one or two lines>
- <option A>
- <option B ${RECOMMENDED_MARKER}>
\`\`\`
Mark your recommended option by appending the literal marker ${RECOMMENDED_MARKER} — keep it verbatim in English even when the rest of your reply is in another language. Ask sparingly, batch related questions, and never ask about details you can decide yourself. Respond in ${langName(lang)}.`
}

// The unified claude chat runner: headless `claude -p --permission-mode bypassPermissions` (the native full-permission experience)
// + a dangerous-command PreToolUse guard (blocks push/gh pr create/rm etc. by default, allowDanger lets them through) + --resume to continue the session.
export async function runClaudeAgentChat(opts: AgentChatOptions): Promise<AgentChatResult> {
  const args = [
    '-p',
    '--verbose',
    '--output-format', 'stream-json',
    '--permission-mode', 'bypassPermissions',
    '--settings', dangerSettingsJson(),
    '--append-system-prompt', opts.systemPrompt,
  ]
  if (opts.model) args.push('--model', opts.model)
  if (opts.effort) args.push('--effort', opts.effort)
  if (opts.sessionId) args.push('--resume', opts.sessionId)

  // ultracode background activation: the harness recognizes this keyword → the agent runs xhigh + multi-agent. The prefix is only added to the input sent to the agent.
  const agentInput = opts.ultracode ? `ultracode: ${opts.message}` : opts.message
  const input = opts.historyAccess ? `${agentInput}\n\n${opts.historyAccess}` : agentInput

  let text = ''
  // Hand over session_id as early as possible (for persistence): stream-json carries it on the very first message; otherwise stopping midway → non-zero exit → we never get it → the next turn loses context.
  let sentSession = false
  const { costUsd, result, sessionId } = await runClaudeStream(args, {
    input,
    cwd: opts.cwd,
    env: dangerEnv(opts.allowDanger),
    onSpawn: opts.onSpawn,
    onEvent: (msg) => {
      if (typeof msg?.session_id === 'string' && !sentSession) { sentSession = true; opts.onSessionId?.(msg.session_id) }
      if (msg?.type !== 'assistant') return
      const content = msg.message?.content
      if (!Array.isArray(content)) return
      for (const b of content) {
        if (b?.type === 'text' && b.text) {
          text += String(b.text)
          opts.onText?.(String(b.text))
        } else if (b?.type === 'tool_use') {
          const input2 = b?.input ?? {}
          const v = input2.command || input2.file_path || input2.path || input2.pattern || ''
          opts.onTool?.(String(b.name), String(v).slice(0, 100))
        }
      }
    },
  })
  if (sessionId && !sentSession) opts.onSessionId?.(sessionId) // backstop
  return { costUsd, sessionId, text: (result || text).trim() }
}

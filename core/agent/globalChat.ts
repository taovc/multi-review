import { runClaudeAgentChat, askUserClause } from './chat'
import { runCodexChat } from './codexChat'
import type { ReviewProvider } from './runners'
import type { ChildProcess } from 'node:child_process'
import type { ProviderUsage } from '../runs/types'

// The global "can do anything" assistant, aligned with feature/fix: claude goes through the shared
// runner (bypassPermissions + dangerous-command guard + ultracode + decision cards); codex goes
// through runCodexChat (the 'global' prompt). --resume continues the session. Images are prefetched
// by the pipeline with fetchIssueContext.

export type GlobalChatOptions = {
  cwd: string
  model: string // empty = claude/codex default
  effort?: string
  codexServiceTier?: string | null
  lang: string
  sessionId: string | null // when set, --resume
  message: string
  historyAccess?: string
  allowDanger?: boolean // let dangerous commands past the guard (the user turned the switch on)
  ultracode?: boolean // activate ultracode in the background (the prefix is injected by the runner)
  onSpawn?: (cp: ChildProcess) => void
  onStop?: (stop: () => void) => void
  onSessionId?: (sessionId: string) => void
  onText?: (text: string) => void
  onTool?: (name: string, info: string) => void
}

export type GlobalChatResult = { costUsd: number; sessionId: string | null; text: string; usage: ProviderUsage | null }

export function globalSystemPrompt(lang: string): string {
  return `You are a capable general-purpose coding assistant. The current directory is the user's chosen working directory. You have the full toolset and full permissions (bash, git, gh, network, tests) — investigate and do whatever the user asks directly.

${askUserClause(lang)}`
}

function runGlobalClaudeChat(opts: GlobalChatOptions): Promise<GlobalChatResult> {
  return runClaudeAgentChat({
    cwd: opts.cwd,
    model: opts.model,
    effort: opts.effort,
    sessionId: opts.sessionId,
    message: opts.message,
    historyAccess: opts.historyAccess,
    systemPrompt: globalSystemPrompt(opts.lang),
    allowDanger: opts.allowDanger,
    ultracode: opts.ultracode,
    onSpawn: opts.onSpawn,
    onSessionId: opts.onSessionId,
    onText: opts.onText,
    onTool: opts.onTool,
  })
}

// The codex path: a free-form assistant whose network/sandbox settings follow allowDanger. The git
// write/push gate only applies to fix/feature (which have an upload gate); global isn't blocked
// (the sandbox = workspace-write/no network is the boundary, opened up when allowDanger is set, matching claude-global).
function runGlobalCodexChat(opts: GlobalChatOptions): Promise<GlobalChatResult> {
  return runCodexChat({
    cwd: opts.cwd, model: opts.model, effort: opts.effort, lang: opts.lang,
    codexServiceTier: opts.codexServiceTier,
    sessionId: opts.sessionId, message: opts.message, historyAccess: opts.historyAccess,
    promptKind: 'global', fullAccess: !!opts.allowDanger, networkAccess: !!opts.allowDanger, ultracode: opts.ultracode,
    onSpawn: opts.onSpawn, onStop: opts.onStop, onSessionId: opts.onSessionId, onText: opts.onText, onTool: opts.onTool,
  })
}

export function runGlobalChat(provider: ReviewProvider, opts: GlobalChatOptions): Promise<GlobalChatResult> {
  return provider === 'codex' ? runGlobalCodexChat(opts) : runGlobalClaudeChat(opts)
}

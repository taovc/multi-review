import { runClaudeAgentChat, askUserClause } from './chat'
import type { ChildProcess } from 'node:child_process'
import type { ProviderUsage } from '../runs/types'

// The global "can do anything" assistant. Both providers now run on the session hosts (core/host, core/codex);
// this legacy one-shot claude runner is kept for the tests/contracts that still exercise it. Images are prefetched
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

export function runGlobalClaudeChat(opts: GlobalChatOptions): Promise<GlobalChatResult> {
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

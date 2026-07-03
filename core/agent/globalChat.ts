import { runClaudeAgentChat, askUserClause } from './chat'
import { runCodexChat } from './codexChat'
import type { ReviewProvider } from './runners'
import type { ChildProcess } from 'node:child_process'

// 全局「啥都能干」助手：和 feature/fix 统一——claude 走共享运行器（bypassPermissions + 危险命令守卫 + ultracode
// + 决策卡）；codex 走 runCodexChat（'global' prompt）。--resume 续会话。图片读取由 pipeline 用 fetchIssueContext 预抓。

export type GlobalChatOptions = {
  cwd: string
  model: string // 空 = claude/codex 默认
  effort?: string
  lang: string
  sessionId: string | null // 有就 --resume
  message: string
  historyAccess?: string
  allowDanger?: boolean // 放行危险命令守卫（用户开了开关）
  ultracode?: boolean // 后台激活 ultracode（前缀由运行器注入）
  onSpawn?: (cp: ChildProcess) => void
  onStop?: (stop: () => void) => void
  onSessionId?: (sessionId: string) => void
  onText?: (text: string) => void
  onTool?: (name: string, info: string) => void
}

export type GlobalChatResult = { costUsd: number; sessionId: string | null; text: string }

function globalSystemPrompt(lang: string): string {
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

// codex 路径：自由助手，联网/沙箱跟 allowDanger 走。git 写/push 门控只对 fix/feature（有上传门控）生效；
// global 不拦（沙箱=workspace-write/断网即边界，allowDanger 时放开，对齐 claude-global）。
function runGlobalCodexChat(opts: GlobalChatOptions): Promise<GlobalChatResult> {
  return runCodexChat({
    cwd: opts.cwd, model: opts.model, effort: opts.effort, lang: opts.lang,
    sessionId: opts.sessionId, message: opts.message, historyAccess: opts.historyAccess,
    promptKind: 'global', fullAccess: !!opts.allowDanger, networkAccess: !!opts.allowDanger, ultracode: opts.ultracode,
    onSpawn: opts.onSpawn, onStop: opts.onStop, onSessionId: opts.onSessionId, onText: opts.onText, onTool: opts.onTool,
  })
}

export function runGlobalChat(provider: ReviewProvider, opts: GlobalChatOptions): Promise<GlobalChatResult> {
  return provider === 'codex' ? runGlobalCodexChat(opts) : runGlobalClaudeChat(opts)
}

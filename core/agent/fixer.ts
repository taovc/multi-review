import { runClaudeAgentChat, askUserClause, type AgentChatResult } from './chat'
import type { ChildProcess } from 'node:child_process'

// 修复 PR = 和 agent 在 PR worktree 里对话，让它直接改文件。claude 走共享运行器（chat.ts）：
// 统一 bypassPermissions + 危险命令守卫 + ultracode + 决策卡（同 feature/global）。不自动 commit：
// 改动留 worktree，用户点「提交并上传」才 commit+push（走 Node 路径 push.post.ts）。

export type FixChatOptions = {
  cwd: string
  model: string
  effort?: string
  codexServiceTier?: string | null
  lang: string
  sessionId: string | null // 有就 --resume；没有就开新会话
  message: string
  historyAccess?: string
  conflictHint?: string
  // ── feature 开发 / 危险命令 / ultracode 共用开关 ──
  promptKind?: 'fix' | 'feature' | 'global' // codex 各自的 prompt：fix=修 PR / feature=新分支开发 / global=自由助手
  baseBranch?: string // feature：开 PR 时的目标分支
  fullAccess?: boolean // codex：true → danger-full-access 沙箱（否则 workspace-write）
  networkAccess?: boolean // codex：true → 放开联网 + web 搜索
  allowDanger?: boolean // claude：放行危险命令守卫（含 git push / gh pr create），默认拦
  ultracode?: boolean // 后台激活 ultracode（前缀由共享运行器注入）
  onSpawn?: (cp: ChildProcess) => void
  onStop?: (stop: () => void) => void
  onSessionId?: (sessionId: string) => void
  onText?: (text: string) => void
  onTool?: (name: string, info: string) => void
}

export type FixChatResult = AgentChatResult

// fix 方法学：在 PR 分支 worktree 里按 reviewer 要求精修；默认别 commit/push。
function fixSystemPrompt(lang: string, conflictHint?: string): string {
  return `You're working on this pull request inside its git worktree (the current directory is the PR branch checked out). Make the changes the reviewer asks for by editing files directly. You have the full toolset — bash, git, gh, network, tests — so investigate the PR whenever it helps (e.g. \`gh pr view\`, run the tests).
${conflictHint ? `\n${conflictHint}\n` : ''}
Do NOT commit or push. The reviewer reviews your edits in the UI and clicks "Upload", which commits and pushes for them. (Only push if the user explicitly asks.)

${askUserClause(lang)}`
}

export async function runFixChat(opts: FixChatOptions): Promise<FixChatResult> {
  return runClaudeAgentChat({
    cwd: opts.cwd,
    model: opts.model,
    effort: opts.effort,
    sessionId: opts.sessionId,
    message: opts.message,
    historyAccess: opts.historyAccess,
    systemPrompt: fixSystemPrompt(opts.lang, opts.conflictHint),
    allowDanger: opts.allowDanger,
    ultracode: opts.ultracode,
    onSpawn: opts.onSpawn,
    onSessionId: opts.onSessionId,
    onText: opts.onText,
    onTool: opts.onTool,
  })
}

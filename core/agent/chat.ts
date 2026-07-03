import { runClaudeStream } from './claudeCli'
import { dangerSettingsJson, dangerEnv } from './dangerGuard'
import { langName } from './lang'
import type { ChildProcess } from 'node:child_process'

// 三个 chat（feature 开发 / 主助手 Global / fix 修复 PR）共用的 claude 运行器 + 共用能力片段。
// 统一：bypassPermissions + 危险命令守卫（dangerGuard）+ ultracode 后台注入 + stream-json 事件解析 +
// 「决策卡」约定（ask-user 块）。三家只差 systemPrompt（各自方法学）、cwd、和「回合收尾」（各 pipeline 自理）。
// —— 图片读取（issue/PR 私有附件）统一走 core/github/issueAssets 的 fetchIssueContext（各 pipeline 在建消息时调用）。

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
  sessionId: string | null // 有就 --resume
  message: string // 干净的用户消息（图片增强由调用方在此之前拼好；ultracode 前缀由本运行器按 flag 注入）
  historyAccess?: string
  systemPrompt: string // 各 chat 的方法学（含 askUserClause）→ --append-system-prompt
  allowDanger?: boolean // 放行危险命令守卫（含 git push / gh pr create）
  ultracode?: boolean // 后台激活 → 给 agent 的消息注入 `ultracode:` 前缀（存库/展示仍是干净消息）
}

export type AgentChatResult = { costUsd: number; sessionId: string | null; text: string }

// 决策卡约定（三家统一）：遇真分叉输出一个 ```ask-user 围栏块并结束回合；前端解析成决策卡（点选项=下一条消息 resume 续）。
// 这段拼进各 chat 的 systemPrompt。claude 与 codex 都用它，行为一致。
export function askUserClause(lang: string): string {
  return `When you hit a GENUINE decision point — a real fork such as architecture, data model, an external contract, or a user-facing tradeoff — STOP and emit EXACTLY one fenced block, then END your turn and wait (the user's answer arrives as the next message):
\`\`\`ask-user
<your question in one or two lines>
- <option A>
- <option B (推荐)>
\`\`\`
Mark your recommended option with (推荐). Ask sparingly, batch related questions, and never ask about details you can decide yourself. Respond in ${langName(lang)}.`
}

// 统一的 claude chat 运行器：headless `claude -p --permission-mode bypassPermissions`（原生全权限体验）
// + 危险命令 PreToolUse 守卫（默认拦 push/gh pr create/rm 等，allowDanger 放行）+ --resume 续会话。
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

  // ultracode 后台激活：harness 认这个关键词 → agent 走 xhigh + 多代理。前缀只加在送给 agent 的输入上。
  const agentInput = opts.ultracode ? `ultracode: ${opts.message}` : opts.message
  const input = opts.historyAccess ? `${agentInput}\n\n${opts.historyAccess}` : agentInput

  let text = ''
  // 尽早交出 session_id（持久化）：stream-json 首条消息就带；否则中途停止 → 非 0 退出 → 拿不到 → 下一轮丢上下文。
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
  if (sessionId && !sentSession) opts.onSessionId?.(sessionId) // 兜底
  return { costUsd, sessionId, text: (result || text).trim() }
}

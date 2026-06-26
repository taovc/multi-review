import { runClaudeStream } from './claudeCli'

export type GlobalChatOptions = {
  cwd: string
  model: string // 空 = claude 默认
  sessionId: string | null // 有就 --resume
  message: string
  onSpawn?: (cp: import('node:child_process').ChildProcess) => void
  onText?: (text: string) => void
  onTool?: (name: string, info: string) => void
}

export type GlobalChatResult = { costUsd: number; sessionId: string | null; text: string }

// 全局「啥都能干」助手：headless claude，bypassPermissions + 不限工具
// （= `claude --dangerously-skip-permissions` 的无头等价）。直接把用户消息当 prompt（原生体验），
// --resume 续会话。⚠️ 无任何工具拦截（CLI 路径没有 canUseTool/guard）——危险命令守卫见后续 PR。
export async function runGlobalChat(opts: GlobalChatOptions): Promise<GlobalChatResult> {
  const args = ['-p', '--verbose', '--output-format', 'stream-json', '--permission-mode', 'bypassPermissions']
  if (opts.model) args.push('--model', opts.model)
  if (opts.sessionId) args.push('--resume', opts.sessionId)

  let text = ''
  const { costUsd, result, sessionId } = await runClaudeStream(args, {
    input: opts.message,
    cwd: opts.cwd,
    onSpawn: opts.onSpawn,
    onEvent: (msg) => {
      if (msg?.type !== 'assistant') return
      const content = msg.message?.content
      if (!Array.isArray(content)) return
      for (const b of content) {
        if (b?.type === 'text' && b.text) {
          text += String(b.text)
          opts.onText?.(String(b.text))
        } else if (b?.type === 'tool_use') {
          const input = b?.input ?? {}
          const v = input.command || input.file_path || input.path || input.pattern || ''
          opts.onTool?.(String(b.name), String(v).slice(0, 100))
        }
      }
    },
  })
  return { costUsd, sessionId, text: (result || text).trim() }
}

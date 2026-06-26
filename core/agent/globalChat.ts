import { writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { runClaudeStream } from './claudeCli'

export type GlobalChatOptions = {
  cwd: string
  model: string // 空 = claude 默认
  sessionId: string | null // 有就 --resume
  message: string
  allowDanger?: boolean // true = 放行危险命令（用户在 UI 开了开关）
  onSpawn?: (cp: import('node:child_process').ChildProcess) => void
  onText?: (text: string) => void
  onTool?: (name: string, info: string) => void
}

export type GlobalChatResult = { costUsd: number; sessionId: string | null; text: string }

// ── 危险命令守卫(PreToolUse hook)──
// CLI 路径没有 SDK 的 canUseTool，唯一可靠拦截点是 hook（已实测：bypassPermissions 下 hook 仍会拦）。
// 默认拦下「不可逆 / 对外」破坏性 Bash 命令；GLOBAL_ALLOW_DANGER=1（用户开了放行开关）时全放行。
// 只 gate 真正危险的——git commit / 普通 curl / gh 读都正常跑。
const DANGER_HOOK_SRC = `import { readFileSync } from 'node:fs'
if (process.env.GLOBAL_ALLOW_DANGER === '1') process.exit(0)
let raw = ''; try { raw = readFileSync(0, 'utf8') } catch {}
let inp = {}; try { inp = JSON.parse(raw) } catch {}
if ((inp.tool_name || '') !== 'Bash') process.exit(0)
const cmd = String((inp.tool_input || {}).command || '')
const DANGER = [
  /\\brm\\s+-[rf]/i, /\\brm\\b[^|;&]*--(recursive|force)\\b/i, /\\bfind\\b[^|;&]*-(delete|exec)\\b/i,
  /\\bsudo\\b/i, /\\bgit\\s+push\\b/i, /\\bgit\\s+reset\\s+--hard\\b/i,
  /\\bgit\\s+clean\\s+-[a-z]*f/i, /\\b(mkfs|shred)\\b/i, /\\bdd\\s+if=/i, /\\bchmod\\s+-R\\b/i, /\\bchown\\s+-R\\b/i,
  /\\b(curl|wget)\\b[^|]*\\|\\s*(sh|bash|zsh|python3?|node|perl|ruby)\\b/i,
  /:\\(\\)\\s*\\{/, />\\s*\\/dev\\/sd/i, /\\bgh\\s+repo\\s+delete\\b/i,
]
if (DANGER.some((re) => re.test(cmd))) {
  process.stderr.write('pr-cockpit danger guard blocked: ' + cmd.slice(0, 160) + ' — turn on "allow dangerous commands" and resend to permit.')
  process.exit(2)
}
process.exit(0)
`

let _hookPath: string | null = null
function ensureDangerHook(): string {
  if (_hookPath && existsSync(_hookPath)) return _hookPath
  const dir = join(process.cwd(), 'data')
  try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) } catch { /* ignore */ }
  const p = join(dir, 'global-danger-hook.mjs')
  try { writeFileSync(p, DANGER_HOOK_SRC, 'utf8') } catch { /* ignore */ }
  _hookPath = p
  return p
}

// 全局「啥都能干」助手：headless claude，bypassPermissions + 不限工具
// （= `claude --dangerously-skip-permissions` 的无头等价）。直接把用户消息当 prompt（原生体验），
// --resume 续会话。危险命令由 PreToolUse hook 默认拦截，allowDanger 时放行。
export async function runGlobalChat(opts: GlobalChatOptions): Promise<GlobalChatResult> {
  const hook = ensureDangerHook()
  const settings = JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `node ${hook}` }] }] },
  })
  const args = ['-p', '--verbose', '--output-format', 'stream-json', '--permission-mode', 'bypassPermissions', '--settings', settings]
  if (opts.model) args.push('--model', opts.model)
  if (opts.sessionId) args.push('--resume', opts.sessionId)

  let text = ''
  const { costUsd, result, sessionId } = await runClaudeStream(args, {
    input: opts.message,
    cwd: opts.cwd,
    env: opts.allowDanger ? { GLOBAL_ALLOW_DANGER: '1' } : undefined,
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

import { spawn } from 'node:child_process'
import { resolveClaudeExecutable } from './claude-bin'

// 跑 `claude --print ...`。prompt 走 stdin（写完立即 end）：既不会因超长参数撞 ARG_MAX，
// 也不会出现 "no stdin data received" 卡死（我们主动写入并关闭 stdin）。
export function runClaude(
  args: string[],
  opts: { input?: string; timeout?: number; maxBuffer?: number } = {},
): Promise<string> {
  const timeout = opts.timeout ?? 120_000
  const maxBuffer = opts.maxBuffer ?? 1024 * 1024 * 32
  const hasInput = typeof opts.input === 'string'
  return new Promise((resolve, reject) => {
    const cp = spawn('claude', args, { stdio: [hasInput ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    let done = false
    const finish = (fn: () => void) => {
      if (done) return
      done = true
      clearTimeout(timer)
      fn()
    }
    const timer = setTimeout(() => finish(() => { cp.kill('SIGKILL'); reject(new Error('claude 调用超时')) }), timeout)
    cp.stdout!.on('data', (d) => {
      out += d
      if (out.length > maxBuffer) finish(() => { cp.kill('SIGKILL'); reject(new Error('claude 输出超限')) })
    })
    cp.stderr!.on('data', (d) => { err += d })
    cp.on('error', (e) => finish(() => reject(e)))
    cp.on('close', (code) =>
      finish(() => (code === 0 ? resolve(out) : reject(new Error(`claude 退出码 ${code}: ${err.slice(0, 300)}`)))),
    )
    if (hasInput) {
      cp.stdin!.on('error', () => {}) // 防 EPIPE 崩溃
      cp.stdin!.write(opts.input!)
      cp.stdin!.end()
    }
  })
}

// 跑一个长任务（修复 agent）：`claude -p --output-format stream-json`，逐行解析 NDJSON，
// 每条消息回调 onEvent（assistant 文本 / tool_use / result），从 result 累计 total_cost_usd。
// 与 runClaude 不同：不一次性 buffer，而是流式消费（修复耗时长，需要实时进度）。
export type StreamMsg = Record<string, any>
export function runClaudeStream(
  args: string[],
  opts: { input?: string; cwd?: string; timeout?: number; onEvent?: (msg: StreamMsg) => void } = {},
): Promise<{ costUsd: number; result: string }> {
  const timeout = opts.timeout ?? 30 * 60_000 // 修复可能跑很久
  const bin = resolveClaudeExecutable() ?? 'claude'
  const hasInput = typeof opts.input === 'string'
  return new Promise((resolve, reject) => {
    const cp = spawn(bin, args, { cwd: opts.cwd, stdio: [hasInput ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
    let buf = ''
    let err = ''
    let costUsd = 0
    let result = ''
    let done = false
    const finish = (fn: () => void) => {
      if (done) return
      done = true
      clearTimeout(timer)
      fn()
    }
    const timer = setTimeout(() => finish(() => { cp.kill('SIGKILL'); reject(new Error('claude 修复调用超时')) }), timeout)

    cp.stdout!.setEncoding('utf8')
    cp.stdout!.on('data', (d: string) => {
      buf += d
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        let msg: StreamMsg
        try {
          msg = JSON.parse(line)
        } catch {
          continue // 非 JSON 行（极少）跳过
        }
        if (msg?.type === 'result') {
          if (typeof msg.total_cost_usd === 'number') costUsd = msg.total_cost_usd
          if (typeof msg.result === 'string') result = msg.result
        }
        try {
          opts.onEvent?.(msg)
        } catch {
          /* 订阅者异常不影响主流程 */
        }
      }
    })
    cp.stderr!.on('data', (d) => { err += d })
    cp.on('error', (e) => finish(() => reject(e)))
    cp.on('close', (code) =>
      finish(() => (code === 0 ? resolve({ costUsd, result }) : reject(new Error(`claude 修复退出码 ${code}: ${err.slice(0, 500)}`)))),
    )
    if (hasInput) {
      cp.stdin!.on('error', () => {})
      cp.stdin!.write(opts.input!)
      cp.stdin!.end()
    }
  })
}

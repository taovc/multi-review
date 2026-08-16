import { spawn } from 'node:child_process'
import { resolveClaudeExecutable } from './claude-bin'

// Run `claude --print ...`. The prompt goes through stdin (ended right after writing): this neither
// hits ARG_MAX with an oversized argument nor hangs on "no stdin data received" (we write and close
// stdin ourselves).
export function runClaude(
  args: string[],
  opts: { input?: string; timeout?: number; maxBuffer?: number } = {},
): Promise<string> {
  const timeout = opts.timeout ?? 120_000
  const maxBuffer = opts.maxBuffer ?? 1024 * 1024 * 32
  const hasInput = typeof opts.input === 'string'
  return new Promise((resolve, reject) => {
    // In a production build PATH may not contain claude → use the shared resolution logic (see claude-bin.ts)
    const cp = spawn(resolveClaudeExecutable() ?? 'claude', args, { stdio: [hasInput ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
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
      cp.stdin!.on('error', () => {}) // guard against an EPIPE crash
      cp.stdin!.write(opts.input!)
      cp.stdin!.end()
    }
  })
}

// Run a long task (the fix agent): `claude -p --output-format stream-json`, parse the NDJSON line by
// line, call onEvent for every message (assistant text / tool_use / result), and accumulate
// total_cost_usd from result.
// Unlike runClaude: no single buffer, it consumes the stream (fixes take long and need live progress).
export type StreamMsg = Record<string, any>
export function runClaudeStream(
  args: string[],
  // onSpawn exposes the child process handle to the caller (the M2 stop button has to kill it)
  opts: { input?: string; cwd?: string; timeout?: number; idleTimeout?: number; env?: Record<string, string>; onEvent?: (msg: StreamMsg) => void; onSpawn?: (cp: import('node:child_process').ChildProcess) => void } = {},
): Promise<{ costUsd: number; result: string; sessionId: string | null }> {
  // Idle timeout: the agent can run for a long time (ultracode with many subagents / opus[1m] / big
  // changes are all normal) — as long as it keeps producing output, don't kill it.
  // Any output resets the timer; we only kill runs that are truly stuck with no output for a long
  // time. timeout = absolute upper bound as a backstop (against runaways), very large by default.
  const idleMs = opts.idleTimeout ?? 20 * 60_000
  const hardMs = opts.timeout ?? 4 * 60 * 60_000
  const bin = resolveClaudeExecutable() ?? 'claude'
  const hasInput = typeof opts.input === 'string'
  return new Promise((resolve, reject) => {
    // detached:true → the child becomes its own process group leader, so stopping can signal the whole group (including processes it spawned), same as Ctrl+C.
    const cp = spawn(bin, args, { cwd: opts.cwd, stdio: [hasInput ? 'pipe' : 'ignore', 'pipe', 'pipe'], detached: true, ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}) })
    opts.onSpawn?.(cp)
    let buf = ''
    let err = ''
    let costUsd = 0
    let result = ''
    let sessionId: string | null = null // comes with stream-json, kept for resuming the chat later with --resume
    let done = false
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    let hardTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (fn: () => void) => {
      if (done) return
      done = true
      clearTimeout(idleTimer); clearTimeout(hardTimer)
      fn()
    }
    const killTree = (sig: NodeJS.Signals) => { try { process.kill(-(cp.pid as number), sig) } catch { try { cp.kill(sig) } catch { /* already exited */ } } }
    // Every chunk of output resets the idle timer (output = not stuck); the hard limit is only a runaway backstop.
    const armIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => finish(() => { killTree('SIGKILL'); reject(new Error(`claude 调用超时（${Math.round(idleMs / 60_000)} 分钟无输出）`)) }), idleMs) }
    hardTimer = setTimeout(() => finish(() => { killTree('SIGKILL'); reject(new Error(`claude 调用超时（超过 ${Math.round(hardMs / 60_000)} 分钟上限）`)) }), hardMs)
    armIdle()

    const consume = (line: string) => {
      if (!line) return
      let msg: StreamMsg
      try {
        msg = JSON.parse(line)
      } catch {
        return // skip non-JSON lines (very rare)
      }
      if (typeof msg?.session_id === 'string' && !sessionId) sessionId = msg.session_id
      if (msg?.type === 'result') {
        if (typeof msg.total_cost_usd === 'number') costUsd = msg.total_cost_usd
        if (typeof msg.result === 'string') result = msg.result
      }
      try {
        opts.onEvent?.(msg)
      } catch {
        /* a subscriber throwing must not affect the main flow */
      }
    }
    cp.stdout!.setEncoding('utf8')
    cp.stdout!.on('data', (d: string) => {
      armIdle() // output → reset the idle timer
      buf += d
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        consume(line)
      }
    })
    cp.stderr!.on('data', (d) => { armIdle(); err += d })
    cp.on('error', (e) => finish(() => reject(e)))
    cp.on('close', (code) => {
      consume(buf.trim()) // the last line may have no trailing newline (losing the result line would cost us cost/sessionId)
      finish(() => (code === 0 ? resolve({ costUsd, result, sessionId }) : reject(new Error(`claude 退出码 ${code}: ${err.slice(0, 500)}`))))
    })
    if (hasInput) {
      cp.stdin!.on('error', () => {})
      cp.stdin!.write(opts.input!)
      cp.stdin!.end()
    }
  })
}

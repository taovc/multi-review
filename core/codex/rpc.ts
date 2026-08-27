import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'

// JSON-RPC 2.0 over newline-delimited JSON on the app-server's stdio. Three message shapes come back:
// responses (id + result|error), server→client requests (id + method — approvals, user input) and notifications
// (method, no id). Nothing here knows about threads; routing by threadId is the app-server module's job.

export class RpcError extends Error {
  code: number
  data: unknown
  constructor(method: string, code: number, message: string, data?: unknown) {
    super(`${method}: ${message}`)
    this.name = 'RpcError'
    this.code = code
    this.data = data
  }
}

type Pending = { method: string; resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> | null }

export type RpcEvents = {
  notification: [method: string, params: any]
  serverRequest: [id: number | string, method: string, params: any]
  exit: [code: number | null, signal: NodeJS.Signals | null]
  stderr: [text: string]
}

const DEFAULT_TIMEOUT_MS = 30_000
// -32001 = the server is overloaded / applying backpressure: retry a few times before giving up.
const OVERLOADED = -32001
const RETRY_DELAYS_MS = [300, 1000, 3000]

export class CodexRpc extends EventEmitter<RpcEvents> {
  private child: ChildProcess
  private nextId = 1
  private pending = new Map<number, Pending>()
  private buf = ''
  private _alive = true
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null

  constructor(bin: string, args: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {}) {
    super()
    // A .mjs/.js "binary" runs under the current node — lets tests point CODEX_EXECUTABLE at a mock app-server.
    const viaNode = /\.(mjs|cjs|js)$/.test(bin)
    this.child = spawn(viaNode ? process.execPath : bin, viaNode ? [bin, ...args] : args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: opts.env ?? process.env,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      // Never a shell: the user's shell aliases codex to --dangerously-bypass-approvals-and-sandbox.
      shell: false,
    })
    this.child.stdout!.setEncoding('utf8')
    this.child.stdout!.on('data', (d: string) => this.onData(d))
    this.child.stderr!.setEncoding('utf8')
    this.child.stderr!.on('data', (d: string) => this.emit('stderr', d))
    this.child.once('error', (e) => this.die(`spawn failed: ${e.message}`))
    this.child.once('exit', (code, signal) => {
      this.exitInfo = { code, signal }
      this.die(`app-server exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})`)
      this.emit('exit', code, signal)
    })
  }

  get alive(): boolean { return this._alive }
  get pid(): number | undefined { return this.child.pid }
  get exit(): { code: number | null; signal: NodeJS.Signals | null } | null { return this.exitInfo }

  private onData(chunk: string): void {
    this.buf += chunk
    let i: number
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim()
      this.buf = this.buf.slice(i + 1)
      if (!line) continue
      let msg: any
      try { msg = JSON.parse(line) } catch { this.emit('stderr', `[rpc] unparseable line: ${line.slice(0, 200)}\n`); continue }
      this.route(msg)
    }
  }

  private route(msg: any): void {
    if (msg && typeof msg === 'object' && msg.id != null && typeof msg.method === 'string') {
      this.emit('serverRequest', msg.id, msg.method, msg.params ?? {})
      return
    }
    if (msg && typeof msg === 'object' && msg.id != null) {
      const p = this.pending.get(Number(msg.id))
      if (!p) return
      this.pending.delete(Number(msg.id))
      if (p.timer) clearTimeout(p.timer)
      if (msg.error) p.reject(new RpcError(p.method, Number(msg.error.code ?? -1), String(msg.error.message ?? 'error'), msg.error.data))
      else p.resolve(msg.result)
      return
    }
    if (msg && typeof msg.method === 'string') this.emit('notification', msg.method, msg.params ?? {})
  }

  private write(obj: unknown): void {
    if (!this._alive) throw new Error('app-server is not running')
    this.child.stdin!.write(JSON.stringify(obj) + '\n')
  }

  async request<T = any>(method: string, params: unknown = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.requestOnce<T>(method, params, timeoutMs)
      } catch (e) {
        const delay = RETRY_DELAYS_MS[attempt]
        if (!(e instanceof RpcError) || e.code !== OVERLOADED || delay === undefined || !this._alive) throw e
        await new Promise((r) => setTimeout(r, delay))
      }
    }
  }

  private requestOnce<T = any>(method: string, params: unknown = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    if (!this._alive) return Promise.reject(new Error(`${method}: app-server is not running`))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => { this.pending.delete(id); reject(new Error(`${method}: no response within ${timeoutMs}ms`)) }, timeoutMs) : null
      timer?.unref?.()
      this.pending.set(id, { method, resolve, reject, timer })
      try { this.write({ jsonrpc: '2.0', id, method, params }) } catch (e) { this.pending.delete(id); if (timer) clearTimeout(timer); reject(e as Error) }
    })
  }

  notify(method: string, params: unknown = {}): void {
    this.write({ jsonrpc: '2.0', method, params })
  }

  // Answer a server→client request.
  respond(id: number | string, result: unknown): void {
    try { this.write({ jsonrpc: '2.0', id, result }) } catch { /* the server is gone; nothing to answer */ }
  }

  respondError(id: number | string, code: number, message: string): void {
    try { this.write({ jsonrpc: '2.0', id, error: { code, message } }) } catch { /* ignore */ }
  }

  private die(reason: string): void {
    if (!this._alive) return
    this._alive = false
    for (const [, p] of this.pending) { if (p.timer) clearTimeout(p.timer); p.reject(new Error(`${p.method}: ${reason}`)) }
    this.pending.clear()
  }

  // SIGTERM, then SIGKILL after a grace period (same envelope as the shutdown plugin's process groups).
  close(graceMs = 1500): void {
    if (this.exitInfo) return
    try { this.child.stdin?.end() } catch { /* ignore */ }
    try { this.child.kill('SIGTERM') } catch { /* ignore */ }
    const t = setTimeout(() => { try { this.child.kill('SIGKILL') } catch { /* ignore */ } }, graceMs)
    t.unref?.()
  }
}

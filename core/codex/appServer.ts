import { EXPECTED_CODEX_VERSION, codexExecutableSource, resolveCodexExecutable } from './bin'
import { codexCliConfig } from '../agent/codexAgent'
import { CodexRpc } from './rpc'

// One `codex app-server` per Nitro process, on stdio, started lazily and restarted on demand after a crash.
// stdio only: a ws:// listener is unauthenticated on loopback and the managed daemon outlives Nitro (which would break
// the shutdown guarantee). Threads are multiplexed on the one connection; this module routes notifications and
// server→client requests to whoever registered the thread id.

export type ThreadHandler = {
  notification: (method: string, params: any) => void
  serverRequest: (id: number | string, method: string, params: any) => void
  crashed: (reason: string) => void
}

export type CodexServer = {
  rpc: CodexRpc
  version: string | null // parsed from the initialize userAgent ("client/x.y.z (...)")
  versionMismatch: string | null // set when the binary is not the pinned @openai/codex version
  codexHome: string | null
  startedAt: number
}

const INIT_TIMEOUT_MS = 15_000
const CLIENT_VERSION = process.env.npm_package_version || '0.0.0'

type State = {
  server: CodexServer | null
  starting: Promise<CodexServer> | null
  threads: Map<string, ThreadHandler>
  failures: number
  lastFailureAt: number
  stderrTail: string
}

// HMR-safe singleton (same pattern as core/events.ts): a dev reload must not orphan the app-server process.
const g = globalThis as unknown as { __codexAppServer?: State }
const state: State = g.__codexAppServer ?? (g.__codexAppServer = { server: null, starting: null, threads: new Map(), failures: 0, lastFailureAt: 0, stderrTail: '' })

function configArgs(): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(codexCliConfig(process.env))) {
    // -c values are parsed as TOML → arrays and strings must be TOML literals.
    const lit = Array.isArray(v) ? `[${v.map((s) => JSON.stringify(s)).join(',')}]` : typeof v === 'string' ? JSON.stringify(v) : String(v)
    out.push('-c', `${k}=${lit}`)
  }
  return out
}

function versionFromUserAgent(ua: unknown): string | null {
  const m = /\/(\d+\.\d+\.\d+[^\s(]*)/.exec(String(ua ?? ''))
  return m ? m[1]! : null
}

async function spawnServer(): Promise<CodexServer> {
  const bin = resolveCodexExecutable()
  if (!bin) throw new Error('Codex CLI binary not found (install @openai/codex or set CODEX_EXECUTABLE)')
  // Backoff after repeated crashes so a broken binary does not respawn in a hot loop.
  const since = Date.now() - state.lastFailureAt
  const wait = state.failures ? Math.min(30_000, 1000 * 2 ** (state.failures - 1)) - since : 0
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))

  const rpc = new CodexRpc(bin, ['app-server', '--listen', 'stdio://', ...configArgs()])
  rpc.on('stderr', (d) => { state.stderrTail = (state.stderrTail + d).slice(-4000) })
  rpc.on('notification', (method, params) => {
    const tid = params && typeof params === 'object' ? (params.threadId ?? params.thread?.id) : undefined
    const h = tid ? state.threads.get(String(tid)) : undefined
    if (h) { try { h.notification(method, params) } catch (e) { console.warn('[codex] handler failed', (e as Error).message) } }
  })
  rpc.on('serverRequest', (id, method, params) => {
    const tid = params && typeof params === 'object' ? params.threadId : undefined
    const h = tid ? state.threads.get(String(tid)) : undefined
    if (h) { try { h.serverRequest(id, method, params) } catch (e) { console.warn('[codex] request handler failed', (e as Error).message); rpc.respondError(id, -32000, 'handler failed') } }
    else rpc.respondError(id, -32601, `no handler for ${method}`)
  })
  rpc.on('exit', (code, signal) => {
    const reason = `codex app-server exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})${state.stderrTail ? `\n${state.stderrTail.slice(-600)}` : ''}`
    if (state.server?.rpc === rpc) state.server = null
    // Anything expected of a died process would have been announced with SIGTERM from close(); everything else is a crash.
    if (signal !== 'SIGTERM') { state.failures++; state.lastFailureAt = Date.now() }
    for (const [tid, h] of [...state.threads]) { state.threads.delete(tid); try { h.crashed(reason) } catch { /* ignore */ } }
  })

  try {
    const init = await rpc.request('initialize', { clientInfo: { name: 'pr-cockpit', version: CLIENT_VERSION }, capabilities: { experimentalApi: true } }, INIT_TIMEOUT_MS)
    rpc.notify('initialized', {})
    state.failures = 0
    const version = versionFromUserAgent(init?.userAgent)
    const versionMismatch = version && version !== EXPECTED_CODEX_VERSION ? `codex ${version} answered, build pinned to ${EXPECTED_CODEX_VERSION} — protocol drift possible (regenerate with pnpm codex:types after bumping @openai/codex)` : null
    const server: CodexServer = { rpc, version, versionMismatch, codexHome: typeof init?.codexHome === 'string' ? init.codexHome : null, startedAt: Date.now() }
    console.log(`[codex] app-server ${server.version ?? '?'} ready (pid ${rpc.pid}) · binary ${codexExecutableSource() ?? '?'}: ${bin}`)
    if (versionMismatch) console.warn(`[codex] ${versionMismatch}`)
    return server
  } catch (e) {
    rpc.close()
    state.failures++
    state.lastFailureAt = Date.now()
    throw new Error(`codex app-server failed to start: ${(e as Error).message}${state.stderrTail ? `\n${state.stderrTail.slice(-600)}` : ''}`)
  }
}

export async function getCodexServer(): Promise<CodexServer> {
  if (state.server && state.server.rpc.alive) return state.server
  if (state.starting) return state.starting
  state.starting = spawnServer().then((s) => { state.server = s; return s }).finally(() => { state.starting = null })
  return state.starting
}

export function codexServerInfo(): { running: boolean; pid: number | undefined; version: string | null; versionMismatch: string | null; codexHome: string | null; threads: number; failures: number } {
  const s = state.server
  return { running: !!(s && s.rpc.alive), pid: s?.rpc.pid, version: s?.version ?? null, versionMismatch: s?.versionMismatch ?? null, codexHome: s?.codexHome ?? null, threads: state.threads.size, failures: state.failures }
}

export function registerThread(threadId: string, h: ThreadHandler): () => void {
  state.threads.set(threadId, h)
  return () => { if (state.threads.get(threadId) === h) state.threads.delete(threadId) }
}

// Stop the process (shutdown). Live threads get a 'crashed' callback from the exit handler so their turns settle.
export function stopCodexServer(): boolean {
  const s = state.server
  if (!s) return false
  state.server = null
  s.rpc.close()
  return true
}

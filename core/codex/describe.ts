import { codexServerInfo, getCodexServer } from './appServer'
import { codexExecutableSource, resolveCodexExecutable } from './bin'

// What Codex actually loads and can do — the transparency page's Codex section, read from the live app-server
// instead of spawning `codex login status` subprocesses. Models are read separately (codexModels.ts); the effective config
// dump and its origins were dropped from the page on purpose (2026-08).
export type CodexConfigReport = {
  bin: string | null
  binSource: string | null
  version: string | null
  server: ReturnType<typeof codexServerInfo>
  auth: { method: string | null; requiresOpenaiAuth: boolean | null }
  mcpServers: Array<{ name: string; authStatus: string; tools: number }>
  skills: Array<{ name: string; description: string; scope: string; enabled: boolean; path: string }>
  rateLimits: { plan: string | null; primary: { usedPercent: number; windowMinutes: number; resetsAt: string | null } | null; secondary: { usedPercent: number; windowMinutes: number; resetsAt: string | null } | null } | null
  error?: string
  at: string
  ms: number
}

const cache = new Map<string, { at: number; report: CodexConfigReport }>()
const inflight = new Map<string, Promise<CodexConfigReport>>()
const TTL = 5 * 60_000

export async function describeCodexConfig(cwd: string, refresh = false): Promise<CodexConfigReport> {
  const hit = cache.get(cwd)
  if (!refresh && hit && Date.now() - hit.at < TTL) return hit.report
  const running = inflight.get(cwd)
  if (running) return running
  const p = build(cwd).finally(() => inflight.delete(cwd))
  inflight.set(cwd, p)
  const report = await p
  cache.set(cwd, { at: Date.now(), report })
  return report
}

async function build(cwd: string): Promise<CodexConfigReport> {
  const t0 = Date.now()
  const base: CodexConfigReport = { bin: resolveCodexExecutable() ?? null, binSource: codexExecutableSource(), version: null, server: codexServerInfo(), auth: { method: null, requiresOpenaiAuth: null }, mcpServers: [], skills: [], rateLimits: null, at: new Date().toISOString(), ms: 0 }
  try {
    const server = await getCodexServer()
    const rpc = server.rpc
    const [auth, mcp, skills, limits] = await Promise.all([
      rpc.request('getAuthStatus', { includeToken: false, refreshToken: false }).catch((e) => ({ _error: (e as Error).message })),
      rpc.request('mcpServerStatus/list', {}).catch((e) => ({ _error: (e as Error).message })),
      rpc.request('skills/list', { cwds: [cwd] }).catch((e) => ({ _error: (e as Error).message })),
      rpc.request('account/rateLimits/read', {}).catch((e) => ({ _error: (e as Error).message })),
    ])
    const errors: string[] = []
    base.version = server.version
    base.server = codexServerInfo()
    if (auth?._error) errors.push(`auth: ${auth._error}`); else base.auth = { method: auth?.authMethod ?? null, requiresOpenaiAuth: auth?.requiresOpenaiAuth ?? null }
    if (mcp?._error) errors.push(`mcp: ${mcp._error}`)
    else base.mcpServers = (mcp?.data ?? []).map((s: any) => ({ name: String(s.name), authStatus: String(s.authStatus ?? 'unknown'), tools: Object.keys(s.tools ?? {}).length }))
    if (skills?._error) errors.push(`skills: ${skills._error}`)
    else base.skills = (skills?.data ?? []).flatMap((entry: any) => (entry.skills ?? []).map((s: any) => ({ name: String(s.name), description: String(s.description ?? ''), scope: String(s.scope ?? ''), enabled: !!s.enabled, path: String(s.path ?? '') })))
    if (!limits?._error) {
      const rl = limits?.rateLimits ?? limits ?? {}
      const win = (w: any) => (w && typeof w.usedPercent === 'number' ? { usedPercent: w.usedPercent, windowMinutes: Number(w.windowDurationMins ?? 0), resetsAt: typeof w.resetsAt === 'number' ? new Date(w.resetsAt * 1000).toISOString() : null } : null)
      base.rateLimits = { plan: rl.planType ?? null, primary: win(rl.primary), secondary: win(rl.secondary) }
    }
    if (base.server.versionMismatch) errors.push(base.server.versionMismatch)
    if (errors.length) base.error = errors.join('; ')
  } catch (e) {
    base.error = (e as Error).message
  }
  base.ms = Date.now() - t0
  return base
}

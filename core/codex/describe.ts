import { codexServerInfo, getCodexServer } from './appServer'
import { codexExecutableSource, resolveCodexExecutable } from './bin'

// What Codex actually loads and can do — the transparency page's Codex section, read from the live app-server
// instead of spawning `codex login status` / `codex debug models` subprocesses.
export type CodexConfigReport = {
  bin: string | null
  binSource: string | null
  version: string | null
  server: ReturnType<typeof codexServerInfo>
  auth: { method: string | null; requiresOpenaiAuth: boolean | null }
  models: Array<{ id: string; defaultEffort: string | null; efforts: string[]; hidden: boolean }>
  config: Record<string, unknown> // the effective values of the keys that matter to runs
  configOrigins: Record<string, string> // key → layer that set it
  mcpServers: Array<{ name: string; authStatus: string; tools: number }>
  skills: Array<{ name: string; scope: string; enabled: boolean; path: string }>
  rateLimits: { plan: string | null; primary: { usedPercent: number; windowMinutes: number; resetsAt: string | null } | null; secondary: { usedPercent: number; windowMinutes: number; resetsAt: string | null } | null } | null
  error?: string
  at: string
  ms: number
}

const KEYS = ['model', 'model_provider', 'model_reasoning_effort', 'approval_policy', 'approvals_reviewer', 'sandbox_mode', 'web_search', 'service_tier', 'model_context_window', 'model_auto_compact_token_limit', 'project_doc_fallback_filenames', 'project_doc_max_bytes', 'hooks', 'plugins', 'features']

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
  const base: CodexConfigReport = { bin: resolveCodexExecutable() ?? null, binSource: codexExecutableSource(), version: null, server: codexServerInfo(), auth: { method: null, requiresOpenaiAuth: null }, models: [], config: {}, configOrigins: {}, mcpServers: [], skills: [], rateLimits: null, at: new Date().toISOString(), ms: 0 }
  try {
    const server = await getCodexServer()
    const rpc = server.rpc
    const [auth, models, cfg, mcp, skills, limits] = await Promise.all([
      rpc.request('getAuthStatus', { includeToken: false, refreshToken: false }).catch((e) => ({ _error: (e as Error).message })),
      rpc.request('model/list', { limit: 50, includeHidden: false }).catch((e) => ({ _error: (e as Error).message })),
      rpc.request('config/read', { cwd, includeLayers: false }).catch((e) => ({ _error: (e as Error).message })),
      rpc.request('mcpServerStatus/list', {}).catch((e) => ({ _error: (e as Error).message })),
      rpc.request('skills/list', { cwds: [cwd] }).catch((e) => ({ _error: (e as Error).message })),
      rpc.request('account/rateLimits/read', {}).catch((e) => ({ _error: (e as Error).message })),
    ])
    const errors: string[] = []
    base.version = server.version
    base.server = codexServerInfo()
    if (auth?._error) errors.push(`auth: ${auth._error}`); else base.auth = { method: auth?.authMethod ?? null, requiresOpenaiAuth: auth?.requiresOpenaiAuth ?? null }
    if (models?._error) errors.push(`models: ${models._error}`)
    else base.models = (models?.data ?? []).map((m: any) => ({ id: String(m.model ?? m.id), defaultEffort: m.defaultReasoningEffort ?? null, efforts: (m.supportedReasoningEfforts ?? []).map((e: any) => String(e?.reasoningEffort ?? e)), hidden: !!m.hidden }))
    if (cfg?._error) errors.push(`config: ${cfg._error}`)
    else {
      const c = cfg?.config ?? {}
      for (const k of KEYS) if (c[k] !== undefined) base.config[k] = k === 'hooks' || k === 'plugins' || k === 'features' ? summarize(c[k]) : c[k]
      for (const [k, v] of Object.entries<any>(cfg?.origins ?? {})) base.configOrigins[k] = String(v?.layer?.type ?? v?.layer ?? v?.source ?? JSON.stringify(v)).slice(0, 80)
    }
    if (mcp?._error) errors.push(`mcp: ${mcp._error}`)
    else base.mcpServers = (mcp?.data ?? []).map((s: any) => ({ name: String(s.name), authStatus: String(s.authStatus ?? 'unknown'), tools: Object.keys(s.tools ?? {}).length }))
    if (skills?._error) errors.push(`skills: ${skills._error}`)
    else base.skills = (skills?.data ?? []).flatMap((entry: any) => (entry.skills ?? []).map((s: any) => ({ name: String(s.name), scope: String(s.scope ?? ''), enabled: !!s.enabled, path: String(s.path ?? '') })))
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

function summarize(v: unknown): unknown {
  if (Array.isArray(v)) return `${v.length} entries`
  if (v && typeof v === 'object') return Object.keys(v as object).join(', ') || '(empty)'
  return v
}

import { codexServerInfo, getCodexServer } from './appServer'
import { join } from 'node:path'
import { codexExecutableSource, resolveCodexExecutable } from './bin'

// What Codex actually loads — the transparency page's Codex tab, read from the live app-server: MCP servers with their
// tools, skills, hooks, installed plugins, the config layers and the instruction files a thread really injects
// (thread/start on an ephemeral thread with no MCP). There is NO startup-context token figure in the protocol: token
// usage only exists per turn, so the page shows file sizes for Codex instead of estimating.
export type CodexConfigReport = {
  bin: string | null
  binSource: string | null
  version: string | null
  server: ReturnType<typeof codexServerInfo>
  mcpServers: Array<{ name: string; authStatus: string; version: string | null; tools: Array<{ name: string; readOnly?: boolean; destructive?: boolean }> }>
  skills: Array<{ name: string; description: string; scope: string; enabled: boolean; path: string }>
  hooks: Array<{ event: string; source: string; enabled: boolean; command: string | null }>
  plugins: Array<{ id: string; name: string; enabled: boolean; version: string | null; sourceType: string | null; marketplace: string }>
  configLayers: Array<{ type: string; file: string | null }> | null // in precedence order as the server lists them; null = config/read failed
  instructionSources: string[] | null // instruction files a thread in this cwd injects (AGENTS.md chain); null = thread/start failed
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

const ann = (a: any) => ({ ...(a?.readOnlyHint != null || a?.readOnly != null ? { readOnly: !!(a.readOnlyHint ?? a.readOnly) } : {}), ...(a?.destructiveHint != null || a?.destructive != null ? { destructive: !!(a.destructiveHint ?? a.destructive) } : {}) })

async function build(cwd: string): Promise<CodexConfigReport> {
  const t0 = Date.now()
  const base: CodexConfigReport = { bin: resolveCodexExecutable() ?? null, binSource: codexExecutableSource(), version: null, server: codexServerInfo(), mcpServers: [], skills: [], hooks: [], plugins: [], configLayers: null, instructionSources: null, at: new Date().toISOString(), ms: 0 }
  try {
    const server = await getCodexServer()
    const rpc = server.rpc
    const call = (method: string, params: unknown) => rpc.request(method, params).catch((e) => ({ _error: (e as Error).message }))
    const [cfg, mcp, skills, hooks, plugins, thread] = await Promise.all([
      call('config/read', { cwd, includeLayers: true }),
      call('mcpServerStatus/list', {}),
      call('skills/list', { cwds: [cwd] }),
      call('hooks/list', { cwds: [cwd] }),
      call('plugin/installed', { cwds: [cwd] }),
      // An ephemeral thread with no MCP servers: the only way the protocol tells which instruction files it injects.
      call('thread/start', { cwd, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only', config: { mcp_servers: {} } }),
    ])
    const errors: string[] = []
    base.version = server.version
    base.server = codexServerInfo()
    if (cfg?._error) errors.push(`config: ${cfg._error}`)
    // The `project` layer variant names its .codex folder, not a file (core/codex/protocol/v2/ConfigLayerSource.ts).
    else base.configLayers = (cfg?.layers ?? []).map((l: any) => ({ type: String(l?.name?.type ?? '?'), file: typeof l?.name?.file === 'string' ? l.name.file : typeof l?.name?.dotCodexFolder === 'string' ? join(l.name.dotCodexFolder, 'config.toml') : null }))
    if (mcp?._error) errors.push(`mcp: ${mcp._error}`)
    else base.mcpServers = (mcp?.data ?? []).map((s: any) => ({ name: String(s.name), authStatus: String(s.authStatus ?? 'unknown'), version: s.serverInfo?.version ? String(s.serverInfo.version) : null, tools: Object.values(s.tools ?? {}).slice(0, 400).map((t: any) => ({ name: String(t.name), ...ann(t.annotations) })) }))
    if (skills?._error) errors.push(`skills: ${skills._error}`)
    else base.skills = (skills?.data ?? []).flatMap((entry: any) => (entry.skills ?? []).map((s: any) => ({ name: String(s.name), description: String(s.description ?? ''), scope: String(s.scope ?? ''), enabled: !!s.enabled, path: String(s.path ?? '') })))
    if (hooks?._error) errors.push(`hooks: ${hooks._error}`)
    else base.hooks = (hooks?.data ?? []).flatMap((entry: any) => (entry.hooks ?? []).map((h: any) => ({ event: String(h.eventName ?? ''), source: String(h.source ?? ''), enabled: h.enabled !== false, command: typeof h.command === 'string' ? h.command : null })))
    if (plugins?._error) errors.push(`plugins: ${plugins._error}`)
    else base.plugins = (plugins?.marketplaces ?? []).flatMap((m: any) => (m.plugins ?? []).filter((p: any) => p.installed !== false).map((p: any) => ({ id: String(p.id ?? p.name), name: String(p.name ?? p.id), enabled: !!p.enabled, version: p.version ? String(p.version) : p.localVersion ? String(p.localVersion) : null, sourceType: p.source?.type ? String(p.source.type) : null, marketplace: String(m.name ?? '') })))
    if (thread?._error) errors.push(`thread: ${thread._error}`)
    else {
      base.instructionSources = (thread?.instructionSources ?? []).map(String)
      const threadId = thread?.thread?.id
      if (threadId) void rpc.request('thread/archive', { threadId }).catch(() => {}) // release the probe thread; nothing else is listening to it
    }
    if (base.server.versionMismatch) errors.push(base.server.versionMismatch)
    if (errors.length) base.error = errors.join('; ')
  } catch (e) {
    base.error = (e as Error).message
  }
  base.ms = Date.now() - t0
  return base
}

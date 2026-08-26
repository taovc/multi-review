import { describeCodexConfig, type CodexConfigReport } from '../codex/describe'
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { buildProbeOptions, projectDirNameFor } from './options'
import { REVIEW_DENY_RULES, REVIEW_DISALLOWED_TOOLS } from './readonly'
import type { AgentSettings } from '../agent/settings'

// Agent configuration transparency: what Claude Code loads for a given cwd (files + effective settings with provenance)
// and what the CLI actually reports once started (commands, agents, models, MCP status, context categories), plus how
// each PR Cockpit run kind overrides it. Values of `env` entries are never returned (settings files may hold secrets).

export type Scope = 'user' | 'project' | 'local' | 'managed'
export type ConfigFile = { path: string; kind: 'settings' | 'memory' | 'rules' | 'skills' | 'commands' | 'agents' | 'plugins' | 'mcp'; scope: Scope; exists: boolean; bytes: number; count: number | null }
export type Sourced<T> = { value: T; source: string }
export type EffectiveSettings = {
  allow: Sourced<string>[]
  deny: Sourced<string>[]
  ask: Sourced<string>[]
  defaultMode: Sourced<string> | null
  model: Sourced<string> | null
  hooks: { event: string; matcher: string; count: number; source: string }[]
  enabledPlugins: Sourced<string>[]
  envKeys: Sourced<string>[]
  otherKeys: Sourced<string>[]
}
export type ProbeReport = {
  cwd: string
  at: string
  ms: number
  error: string | null
  commands: { name: string; description: string; origin: 'plugin' | 'custom' | 'builtin' }[]
  agents: { name: string; description: string; model?: string }[]
  models: { value: string; displayName: string }[]
  account: { subscriptionType?: string; apiProvider?: string; organization?: string }
  mcp: { name: string; status: string; version?: string }[]
  context: { name: string; tokens: number; deferred: boolean }[]
}
export type RunKindOverride = { kind: 'session' | 'review' | 'helper'; settingSources: string; systemPrompt: string; permissionMode: string; hooks: string; mcp: string; tools: string; denyRules: string[] }
export type AgentConfigReport = {
  cwd: string
  projectDirName: string | undefined
  files: ConfigFile[]
  settings: EffectiveSettings
  probe: ProbeReport | null
  codex: CodexConfigReport | null // what the Codex app-server reports for this cwd (same probe switch)
  overrides: RunKindOverride[]
  agent: AgentSettings
}

function fileInfo(path: string, kind: ConfigFile['kind'], scope: Scope, countGlob?: (dir: string) => number): ConfigFile {
  const exists = existsSync(path)
  let bytes = 0
  let count: number | null = null
  if (exists) {
    try {
      const st = statSync(path)
      bytes = st.size
      if (st.isDirectory() && countGlob) count = countGlob(path)
    } catch { /* unreadable → report as present with 0 bytes */ }
  }
  return { path, kind, scope, exists, bytes, count }
}

function countMd(dir: string): number {
  try { return readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile() && e.name.endsWith('.md')).length } catch { return 0 }
}
function countSkillDirs(dir: string): number {
  try { return readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory() && existsSync(join(dir, e.name, 'SKILL.md'))).length } catch { return 0 }
}
function countJsonKeys(path: string): number {
  try { const v = JSON.parse(readFileSync(path, 'utf8')); const p = v?.plugins ?? v; return p && typeof p === 'object' ? Object.keys(p).length : 0 } catch { return 0 }
}

export function listConfigFiles(cwd: string): ConfigFile[] {
  const home = homedir()
  const u = join(home, '.claude')
  return [
    fileInfo('/Library/Application Support/ClaudeCode/managed-settings.json', 'settings', 'managed'),
    fileInfo(join(u, 'settings.json'), 'settings', 'user'),
    fileInfo(join(cwd, '.claude', 'settings.json'), 'settings', 'project'),
    fileInfo(join(cwd, '.claude', 'settings.local.json'), 'settings', 'local'),
    fileInfo(join(u, 'CLAUDE.md'), 'memory', 'user'),
    fileInfo(join(u, 'rules'), 'rules', 'user', countMd),
    fileInfo(join(cwd, 'CLAUDE.md'), 'memory', 'project'),
    fileInfo(join(cwd, '.claude', 'CLAUDE.md'), 'memory', 'project'),
    fileInfo(join(cwd, 'CLAUDE.local.md'), 'memory', 'local'),
    fileInfo(join(cwd, 'AGENTS.md'), 'memory', 'project'),
    fileInfo(join(cwd, '.claude', 'rules'), 'rules', 'project', countMd),
    fileInfo(join(u, 'skills'), 'skills', 'user', countSkillDirs),
    fileInfo(join(cwd, '.claude', 'skills'), 'skills', 'project', countSkillDirs),
    fileInfo(join(u, 'commands'), 'commands', 'user', countMd),
    fileInfo(join(cwd, '.claude', 'commands'), 'commands', 'project', countMd),
    fileInfo(join(u, 'agents'), 'agents', 'user', countMd),
    fileInfo(join(cwd, '.claude', 'agents'), 'agents', 'project', countMd),
    fileInfo(join(home, '.claude.json'), 'mcp', 'user'),
    fileInfo(join(cwd, '.mcp.json'), 'mcp', 'project'),
    { ...fileInfo(join(u, 'plugins', 'installed_plugins.json'), 'plugins', 'user'), count: existsSync(join(u, 'plugins', 'installed_plugins.json')) ? countJsonKeys(join(u, 'plugins', 'installed_plugins.json')) : null },
  ]
}

function readJson(path: string): Record<string, any> | null {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null } catch { return null }
}

// Merge the settings files in Claude Code's precedence (managed > local > project > user), remembering where each
// rule came from. Only shapes we render are read; env values are dropped on purpose.
export function effectiveSettings(cwd: string): EffectiveSettings {
  const home = homedir()
  const layers: { source: string; path: string }[] = [
    { source: 'user', path: join(home, '.claude', 'settings.json') },
    { source: 'project', path: join(cwd, '.claude', 'settings.json') },
    { source: 'local', path: join(cwd, '.claude', 'settings.local.json') },
    { source: 'managed', path: '/Library/Application Support/ClaudeCode/managed-settings.json' },
  ]
  const out: EffectiveSettings = { allow: [], deny: [], ask: [], defaultMode: null, model: null, hooks: [], enabledPlugins: [], envKeys: [], otherKeys: [] }
  const known = new Set(['permissions', 'hooks', 'enabledPlugins', 'env', 'model'])
  for (const l of layers) {
    const s = readJson(l.path)
    if (!s) continue
    const perms = s.permissions ?? {}
    for (const k of ['allow', 'deny', 'ask'] as const) for (const r of perms[k] ?? []) out[k].push({ value: String(r), source: l.source })
    if (perms.defaultMode) out.defaultMode = { value: String(perms.defaultMode), source: l.source }
    if (s.model) out.model = { value: String(s.model), source: l.source }
    for (const [event, matchers] of Object.entries(s.hooks ?? {})) {
      for (const m of (Array.isArray(matchers) ? matchers : [])) out.hooks.push({ event, matcher: String((m as any)?.matcher ?? '*'), count: Array.isArray((m as any)?.hooks) ? (m as any).hooks.length : 0, source: l.source })
    }
    for (const [name, on] of Object.entries(s.enabledPlugins ?? {})) if (on) out.enabledPlugins.push({ value: name, source: l.source })
    for (const k of Object.keys(s.env ?? {})) out.envKeys.push({ value: k, source: l.source })
    for (const k of Object.keys(s)) if (!known.has(k)) out.otherKeys.push({ value: k, source: l.source })
  }
  return out
}

// How each run kind departs from the CLI's behaviour (mirrors core/host/options.ts).
export function runKindOverrides(agent: AgentSettings): RunKindOverride[] {
  return [
    { kind: 'session', settingSources: 'user + project + local (CLI default)', systemPrompt: 'Claude Code preset + PR Cockpit session append', permissionMode: 'per session: default / acceptEdits / plan / bypassPermissions', hooks: 'user hooks run · PR Cockpit danger guard on Bash (asks unless "allow dangerous commands")', mcp: `all configured servers${agent.chrome ? ' · --chrome' : ''}`, tools: 'all', denyRules: [] },
    { kind: 'review', settingSources: 'user + project + local (CLI default)', systemPrompt: 'Claude Code preset + operating contract + review skill', permissionMode: 'default, decided automatically (read-only bridge)', hooks: 'user hooks disabled (disableAllHooks) · PR Cockpit read-only guard on every tool', mcp: agent.reviewMcpAllow.length ? `allowed: ${agent.reviewMcpAllow.join(', ')}` : 'all denied', tools: 'Read / Grep / Glob / Skill / Task / TodoWrite + non-dangerous Bash', denyRules: [...REVIEW_DENY_RULES, ...REVIEW_DISALLOWED_TOOLS.map(t => `disallowedTools: ${t}`)] },
    { kind: 'helper', settingSources: 'none', systemPrompt: 'none (plain prompt)', permissionMode: 'no tools', hooks: 'none', mcp: 'none', tools: 'none · 1 turn · not persisted', denyRules: [] },
  ]
}

const PROBE_TTL_MS = 5 * 60_000
const probeCache = new Map<string, ProbeReport>()
const inflight = new Map<string, Promise<ProbeReport>>()

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((res, rej) => { const t = setTimeout(() => rej(new Error(`${what} timed out after ${ms}ms`)), ms); p.then(v => { clearTimeout(t); res(v) }, e => { clearTimeout(t); rej(e) }) })
}

function commandOrigin(name: string): ProbeReport['commands'][number]['origin'] {
  if (name.includes(':')) return 'plugin'
  return 'custom'
}

// Start the CLI exactly like a session would, ask it what it loaded, never run a turn. Cached per cwd+chrome.
export async function probeAgent(cwd: string, chrome: boolean, refresh = false): Promise<ProbeReport> {
  const key = `${cwd}|${chrome ? 1 : 0}`
  const hit = probeCache.get(key)
  if (hit && !refresh && Date.now() - Date.parse(hit.at) < PROBE_TTL_MS) return hit
  const running = inflight.get(key)
  if (running) return running
  const p = (async (): Promise<ProbeReport> => {
    const started = Date.now()
    const abort = new AbortController()
    const report: ProbeReport = { cwd, at: new Date().toISOString(), ms: 0, error: null, commands: [], agents: [], models: [], account: {}, mcp: [], context: [] }
    const never = (async function* () { await new Promise<void>((r) => abort.signal.addEventListener('abort', () => r(), { once: true })) })()
    let q: ReturnType<typeof query> | null = null
    try {
      q = query({ prompt: never as any, options: buildProbeOptions({ cwd, chrome, projectDirName: projectDirNameFor(cwd), abort }) })
      const init = await withTimeout(q.initializationResult(), 60_000, 'initialization')
      report.commands = (init.commands ?? []).map(c => ({ name: c.name, description: c.description, origin: commandOrigin(c.name) }))
      report.agents = (init.agents ?? []).map(a => ({ name: a.name, description: a.description, ...(a.model ? { model: a.model } : {}) }))
      report.models = (init.models ?? []).map(m => ({ value: m.value, displayName: m.displayName }))
      report.account = { subscriptionType: init.account?.subscriptionType, apiProvider: init.account?.apiProvider, organization: init.account?.organization }
      const [mcp, ctx] = await Promise.all([
        withTimeout(q.mcpServerStatus(), 30_000, 'mcpServerStatus').catch(() => []),
        withTimeout(q.getContextUsage(), 30_000, 'getContextUsage').catch(() => null),
      ])
      report.mcp = (mcp as any[]).map(s => ({ name: s.name, status: s.status, ...(s.serverInfo?.version ? { version: String(s.serverInfo.version) } : {}) }))
      report.context = ((ctx as any)?.categories ?? []).map((c: any) => ({ name: String(c.name), tokens: Number(c.tokens ?? 0), deferred: !!c.isDeferred }))
    } catch (e) {
      report.error = (e as Error).message
    } finally {
      try { q?.close() } catch { /* already closed */ }
      abort.abort()
    }
    report.ms = Date.now() - started
    probeCache.set(key, report)
    return report
  })()
  inflight.set(key, p)
  try { return await p } finally { inflight.delete(key) }
}

export async function agentConfigReport(opts: { cwd: string; agent: AgentSettings; probe: boolean; refresh?: boolean }): Promise<AgentConfigReport> {
  const cwd = resolve(opts.cwd)
  const [probe, codex] = opts.probe ? await Promise.all([probeAgent(cwd, opts.agent.chrome, opts.refresh), describeCodexConfig(cwd, opts.refresh)]) : [null, null]
  return {
    cwd,
    projectDirName: projectDirNameFor(cwd),
    files: listConfigFiles(cwd),
    settings: effectiveSettings(cwd),
    probe,
    codex,
    overrides: runKindOverrides(opts.agent),
    agent: opts.agent,
  }
}

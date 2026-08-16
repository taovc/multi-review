import { existsSync, readdirSync } from 'node:fs'
import { join, delimiter } from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { Codex, type ThreadEvent, type ThreadOptions } from '@openai/codex-sdk'
import { shouldBlockCodexCommand } from './commandGuard'
import { extractCodexErrorMessage } from './codexErrors'

export { isForbiddenRemoteOrGitMutation } from './commandGuard'

const DEFAULT_PROJECT_DOC_FALLBACKS = ['CLAUDE.md', '.claude/CLAUDE.md']
const DEFAULT_PROJECT_DOC_MAX_BYTES = 64 * 1024
export type CodexServiceTier = 'fast'
export type CodexReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'
export type CodexConfigOverrides = {
  serviceTier?: CodexServiceTier | string | null
  reasoningEffort?: CodexReasoningEffort | null
}

const CODEX_REASONING_EFFORTS = new Set<CodexReasoningEffort>(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])

// Only accept efforts the CLI model catalog can return; empty/unknown falls back to Codex's default.
// max / ultra are passed through Codex config because the ThreadOptions type in SDK 0.144.4 still only lists up to xhigh.
export function toCodexEffort(effort?: string): CodexReasoningEffort | undefined {
  return CODEX_REASONING_EFFORTS.has(effort as CodexReasoningEffort) ? effort as CodexReasoningEffort : undefined
}

function splitConfigList(value?: string): string[] {
  return (value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export function codexCliConfig(env: NodeJS.ProcessEnv = process.env, overrides?: CodexConfigOverrides): Record<string, string | number | boolean | string[]> {
  const fallbacks = splitConfigList(env.CODEX_PROJECT_DOC_FALLBACK_FILENAMES)
  const maxBytes = Number(env.CODEX_PROJECT_DOC_MAX_BYTES)
  const rawServiceTier = overrides && 'serviceTier' in overrides ? overrides.serviceTier : env.CODEX_SERVICE_TIER
  const serviceTier = (rawServiceTier || '').trim()
  const config: Record<string, string | number | boolean | string[]> = {
    project_doc_fallback_filenames: fallbacks.length ? fallbacks : DEFAULT_PROJECT_DOC_FALLBACKS,
    project_doc_max_bytes: Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : DEFAULT_PROJECT_DOC_MAX_BYTES,
  }
  if (serviceTier) config.service_tier = serviceTier
  const reasoningEffort = toCodexEffort(overrides?.reasoningEffort || undefined)
  if (reasoningEffort) config.model_reasoning_effort = reasoningEffort
  return config
}

function isGitWorkTree(cwd: string): boolean {
  try {
    execFileSync('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export function codexWorkingDirectoryOptions(cwd?: string): Pick<ThreadOptions, 'workingDirectory' | 'skipGitRepoCheck'> {
  if (!cwd) return { skipGitRepoCheck: true }
  return isGitWorkTree(cwd)
    ? { workingDirectory: cwd }
    : { workingDirectory: cwd, skipGitRepoCheck: true }
}

// Platform → Rust target triple (the Codex binary lives under vendor/<triple>/bin/codex).
const CODEX_TARGET_TRIPLE: Record<string, string> = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'win32-x64': 'x86_64-pc-windows-msvc',
}

// Look up the Codex CLI binary path by file inside the "real project node_modules" (process.cwd()).
// Why this is needed: the nitro production build only bundles @openai/codex-sdk's JS into .output, without the platform binary packages
// (@openai/codex and @openai/codex-<platform>-<arch>). The SDK's own resolution is based on the bundled import.meta.url,
// which finds no binary inside .output → new Codex() throws "Unable to locate Codex CLI binaries".
// Here we look the binary up directly in node_modules by file, independent of how it was bundled; once found we pass it explicitly to codexPathOverride.
// Not using require.resolve: @openai/codex-sdk is ESM-only and its exports don't expose package.json, so CJS resolution fails.
function codexBinCandidates(triple: string, binName: string): string[] {
  const cwd = process.cwd()
  const key = `${process.platform}-${process.arch}`
  const out: string[] = []
  // pnpm store: .pnpm/@openai+codex@<ver>-<platform>-<arch>/node_modules/@openai/codex/vendor/<triple>/bin/codex
  const pnpmDir = join(cwd, 'node_modules', '.pnpm')
  try {
    // An interrupted pnpm update can briefly leave several versions behind; prefer the newest so we don't land on an old model catalog again.
    const entries = readdirSync(pnpmDir)
      .filter((entry) => entry.startsWith('@openai+codex@') && entry.endsWith(`-${key}`))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }))
    for (const entry of entries) {
      out.push(join(pnpmDir, entry, 'node_modules', '@openai', 'codex', 'vendor', triple, 'bin', binName))
    }
  } catch { /* no .pnpm directory (non-pnpm layout) → fall through to the hoisted candidates below */ }
  // npm/yarn flat layout
  out.push(join(cwd, 'node_modules', '@openai', `codex-${key}`, 'vendor', triple, 'bin', binName))
  out.push(join(cwd, 'node_modules', '@openai', 'codex', 'vendor', triple, 'bin', binName))
  return out
}

// production backstop: when node_modules has no vendor binary (after bundling, cwd isn't the project root),
// use the codex CLI the user installed globally, from PATH / the usual install directories. Symmetric with claude-bin's fromPath.
function codexFromPath(binName: string): string | undefined {
  const dirs = (process.env.PATH || '').split(delimiter)
  dirs.push(join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin')
  for (const d of dirs) {
    if (!d) continue
    const p = join(d, binName)
    if (existsSync(p)) return p
  }
  return undefined
}

let _codexBin: string | null | undefined
export function resolveCodexExecutable(): string | undefined {
  if (_codexBin !== undefined) return _codexBin ?? undefined
  const envBin = process.env.CODEX_EXECUTABLE
  if (envBin && existsSync(envBin)) return (_codexBin = envBin)
  const triple = CODEX_TARGET_TRIPLE[`${process.platform}-${process.arch}`]
  if (triple) {
    const binName = process.platform === 'win32' ? 'codex.exe' : 'codex'
    for (const cand of codexBinCandidates(triple, binName)) {
      if (existsSync(cand)) return (_codexBin = cand)
    }
    const fromPath = codexFromPath(binName)
    if (fromPath) return (_codexBin = fromPath)
  }
  _codexBin = null
  return undefined
}

// Use a local OpenAI key if there is one; otherwise leave it to the Codex CLI's local login (don't override env, let it inherit gh/codex credentials).
// codexPathOverride: point explicitly at the resolved binary, working around nitro bundling losing track of it.
export function newCodex(overrides?: CodexConfigOverrides): Codex {
  const executablePath = resolveCodexExecutable()
  return new Codex({
    ...(executablePath ? { codexPathOverride: executablePath } : {}),
    config: codexCliConfig(process.env, overrides),
    ...(process.env.OPENAI_API_KEY ? { apiKey: process.env.OPENAI_API_KEY } : {}),
  })
}

// Event handling for the read-only agent stages (first review / feedback re-review / recheck / skill generation):
// - turn.failed / error / error item → throw
// - command_execution → log + block write operations
// - file_change (shouldn't happen in read-only, in theory) / mcp / web_search → log
// - agent_message (item.completed) → return the final text (JSON or markdown body)
function emitReadonlyEvent(event: ThreadEvent, label: string, onTool?: (name: string, info: string) => void): string | null {
  if (event.type === 'turn.failed') throw new Error(`Codex ${label} turn failed: ${extractCodexErrorMessage(event.error.message)}`)
  if (event.type === 'error') throw new Error(`Codex ${label} stream failed: ${extractCodexErrorMessage(event.message)}`)
  if (event.type !== 'item.completed') return null

  const { item } = event
  if (item.type === 'command_execution') {
    onTool?.('CodexCommand', item.command.slice(0, 100))
    if (shouldBlockCodexCommand(item.command, { scope: 'readonly' })) {
      throw new Error(`Codex ${label} attempted a forbidden git/GitHub mutation: ${item.command}`)
    }
  } else if (item.type === 'file_change') {
    onTool?.('CodexFileChange', item.changes.map((c) => `${c.kind}:${c.path}`).join(', ').slice(0, 100))
  } else if (item.type === 'mcp_tool_call') {
    onTool?.('CodexMcp', `${item.server}.${item.tool}`.slice(0, 100))
  } else if (item.type === 'web_search') {
    onTool?.('CodexWebSearch', item.query.slice(0, 100))
  } else if (item.type === 'agent_message') {
    return item.text
  } else if (item.type === 'error') {
    // In the SDK, ErrorItem is a "non-fatal" error (e.g. a codex plugin hooks parse warning). Log it, don't interrupt.
    // Fatal cases are backstopped by turn.failed / the top-level error event (thrown above) or by "no final output" (thrown by the caller).
    onTool?.('CodexWarning', item.message.slice(0, 140))
  }
  return null
}

// Run a "read-only" Codex agent: read-only sandbox, approval=never, optional network access (so gh can read PR comments).
// With outputSchema it forces structured JSON. Returns the final agent_message text (parsed by the caller).
export async function runCodexReadonly(opts: {
  prompt: string
  cwd?: string
  model?: string
  effort?: string
  serviceTier?: CodexServiceTier | string | null
  outputSchema?: unknown
  allowNetwork?: boolean // recheck / feedback re-review need gh to read comments → allow network (writes are still blocked by the command guard)
  label: string
  onTool?: (name: string, info: string) => void
  onStop?: (stop: () => void) => void // expose an abort callback: it sets a flag on stop, and the event loop aborts consumption once it notices (used by the stop button in the feature analysis stage)
}): Promise<string> {
  const effort = toCodexEffort(opts.effort)
  const codex = newCodex({
    ...('serviceTier' in opts ? { serviceTier: opts.serviceTier } : {}),
    ...(effort ? { reasoningEffort: effort } : {}),
  })
  const thread = codex.startThread({
    ...(opts.model ? { model: opts.model } : {}),
    ...codexWorkingDirectoryOptions(opts.cwd),
    sandboxMode: 'read-only',
    approvalPolicy: 'never',
    networkAccessEnabled: !!opts.allowNetwork,
    webSearchMode: 'disabled',
    webSearchEnabled: false,
  })

  // Stopping: the codex SDK has no explicit abort, so we rely on a flag + throwing when the next event arrives to break the for-await (which triggers events.return() cleanup).
  // Codex research emits command/reasoning events frequently, so the abort takes effect quickly.
  let aborted = false
  opts.onStop?.(() => { aborted = true })

  const { events } = await thread.runStreamed(opts.prompt, opts.outputSchema ? { outputSchema: opts.outputSchema } : {})
  let raw = ''
  for await (const event of events) {
    if (aborted) throw new Error(`Codex ${opts.label} 已被用户停止`)
    const text = emitReadonlyEvent(event, opts.label, opts.onTool)
    if (text != null) raw = text
  }
  if (aborted) throw new Error(`Codex ${opts.label} 已被用户停止`)
  if (!raw.trim()) throw new Error(`Codex ${opts.label} returned no final response.`)
  return raw
}

// One-shot text generation (translating comments before posting): read-only, no network, no need for streamed tool progress. Returns the final text.
export async function runCodexText(opts: {
  prompt: string
  cwd?: string
  model?: string
  effort?: string
  serviceTier?: CodexServiceTier | string | null
}): Promise<string> {
  const effort = toCodexEffort(opts.effort)
  const codex = newCodex({
    ...('serviceTier' in opts ? { serviceTier: opts.serviceTier } : {}),
    ...(effort ? { reasoningEffort: effort } : {}),
  })
  const thread = codex.startThread({
    ...(opts.model ? { model: opts.model } : {}),
    ...codexWorkingDirectoryOptions(opts.cwd),
    sandboxMode: 'read-only',
    approvalPolicy: 'never',
    networkAccessEnabled: false,
    webSearchMode: 'disabled',
    webSearchEnabled: false,
  })
  const turn = await thread.run(opts.prompt)
  return (turn.finalResponse || '').trim()
}

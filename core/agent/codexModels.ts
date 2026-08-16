import { spawn } from 'node:child_process'
import { resolveCodexExecutable } from './codexAgent'

// Read the models "actually available to the current account" from `codex debug models` (including the reasoning effort levels each model supports).
// Not hardcoded: a ChatGPT login and an API key can use different models, and only the CLI knows the truth.
export type CodexModel = {
  value: string // slug, passed as -m / the SDK's model
  displayName: string
  description: string
  supportsEffort: boolean
  effortLevels: string[]
}

let _cache: { value: CodexModel[]; at: number } | null = null
const TTL = 5 * 60_000

export async function getCodexModels(force = false): Promise<CodexModel[]> {
  if (!force && _cache && Date.now() - _cache.at < TTL) return _cache.value
  const value = await resolveCodexModels()
  if (value.length) _cache = { value, at: Date.now() } // only cache non-empty results, so one failure doesn't cache an empty list
  return value
}

async function resolveCodexModels(): Promise<CodexModel[]> {
  const bin = resolveCodexExecutable()
  if (!bin) return []
  const raw = await runDebugModels(bin).catch(() => '')
  return parseCodexModels(raw)
}

export function parseCodexModels(raw: string): CodexModel[] {
  if (!raw.trim()) return []
  let parsed: { models?: unknown }
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  const models = Array.isArray(parsed.models) ? (parsed.models as Array<Record<string, any>>) : []
  const rank = (m: Record<string, any>) => (typeof m.priority === 'number' ? m.priority : Number.MAX_SAFE_INTEGER)
  return models
    .filter((m) => m && m.visibility === 'list' && typeof m.slug === 'string')
    .sort((a, b) => rank(a) - rank(b)) // the smaller the priority the earlier it sorts (5.5=9 frontier comes first)
    .map((m): CodexModel => {
      const effortLevels = Array.isArray(m.supported_reasoning_levels)
        ? (m.supported_reasoning_levels as Array<Record<string, any>>)
            .map((r) => r?.effort)
            .filter((e): e is string => typeof e === 'string')
        : []
      return {
        value: m.slug,
        displayName: m.display_name || m.slug,
        description: m.description || '',
        supportsEffort: effortLevels.length > 0,
        effortLevels,
      }
    })
}

// The Ultracode switch prefers the native ultra declared in the model catalog; older or unknown models keep the previous xhigh behavior.
// An empty model means Codex's default, in which case we judge by the capabilities of the highest-priority model in the catalog.
export function codexUltracodeEffort(models: CodexModel[], model?: string): 'ultra' | 'xhigh' {
  const selected = model
    ? models.find((m) => m.value === model)
      || (model === 'gpt-5.6' ? models.find((m) => m.value === 'gpt-5.6-sol') : undefined)
    : models[0]
  return selected?.effortLevels.includes('ultra') ? 'ultra' : 'xhigh'
}

function runDebugModels(bin: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(bin, ['debug', 'models'], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
    const chunks: Buffer[] = []
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve('')
    }, 10_000)
    child.stdout?.on('data', (c) => chunks.push(Buffer.from(c)))
    child.once('error', () => {
      clearTimeout(timer)
      resolve('')
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve(code === 0 ? Buffer.concat(chunks).toString('utf8') : '')
    })
  })
}

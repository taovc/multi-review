import { getCodexServer } from '../codex/appServer'

// The models "actually available to the current account", read from the app-server's `model/list` (including the
// reasoning effort levels each model supports). Not hardcoded: a ChatGPT login and an API key can use different
// models, and only Codex knows the truth.
export type CodexModel = {
  value: string // slug, passed as the thread/turn model
  displayName: string
  description: string
  supportsEffort: boolean
  effortLevels: string[]
  supportsFast: boolean // the model lists a speed tier (`serviceTiers` / `additionalSpeedTiers`); the project's Fast switch is a no-op otherwise
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
  try {
    const server = await getCodexServer()
    const res = await server.rpc.request('model/list', { limit: 100, includeHidden: false })
    return modelsFromAppServer(res?.data)
  } catch {
    return []
  }
}

// app-server `model/list` entries → the UI's model list (visible models only, catalog order).
export function modelsFromAppServer(data: unknown): CodexModel[] {
  if (!Array.isArray(data)) return []
  return (data as Array<Record<string, any>>)
    .filter((m) => m && !m.hidden && typeof (m.model ?? m.id) === 'string')
    .map((m): CodexModel => {
      const effortLevels = Array.isArray(m.supportedReasoningEfforts)
        ? (m.supportedReasoningEfforts as Array<any>).map((e) => (typeof e === 'string' ? e : e?.reasoningEffort)).filter((e): e is string => typeof e === 'string')
        : []
      const supportsFast = (Array.isArray(m.serviceTiers) && m.serviceTiers.length > 0) || (Array.isArray(m.additionalSpeedTiers) && m.additionalSpeedTiers.includes('fast'))
      return { value: String(m.model ?? m.id), displayName: m.displayName || String(m.model ?? m.id), description: m.description || '', supportsEffort: effortLevels.length > 0, effortLevels, supportsFast }
    })
}

// Legacy `codex debug models` JSON → the same shape (kept for callers/tests that still hold that output).
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
        supportsFast: false, // the legacy CLI listing carries no tier information
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

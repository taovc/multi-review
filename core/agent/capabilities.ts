import { query } from '@anthropic-ai/claude-agent-sdk'
import { buildHelperOptions } from '../host/options'

export type ModelCap = {
  value: string
  displayName: string
  description: string
  supportsEffort: boolean
  effortLevels: string[]
}

let _cache: { models: ModelCap[]; at: number } | null = null
const TTL = 5 * 60_000

// Read the actually available models (including each model's supported effort levels) from the locally logged-in claude.
export async function getCapabilities(force = false): Promise<{ models: ModelCap[] }> {
  if (!force && _cache && Date.now() - _cache.at < TTL) return { models: _cache.models }

  const gate = new Promise<void>(() => {}) // never resolves, keeps the streaming input open
  async function* input() {
    await gate
  }
  // A helper-shaped query (no user settings, no tools, nothing persisted) is enough to ask the CLI for its model catalog.
  const q = query({ prompt: input(), options: buildHelperOptions({ cwd: process.cwd() }) })
  try {
    const raw = await q.supportedModels()
    const models: ModelCap[] = raw.map((m: any) => ({
      value: m.value,
      displayName: m.displayName || m.value,
      description: m.description || '',
      supportsEffort: !!m.supportsEffort,
      effortLevels: m.supportedEffortLevels || [],
    }))
    _cache = { models, at: Date.now() }
    return { models }
  } finally {
    try {
      await (q as any).return?.()
    } catch {
      /* ignore */
    }
  }
}

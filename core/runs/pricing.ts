import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

// Codex reports tokens but never USD. We estimate from a local rate table (USD per 1M tokens) that the user
// maintains in data/codex-rates.json — e.g. { "asOf": "2026-08-01", "rates": { "gpt-5": { "input": 1.25, "cachedInput": 0.125, "output": 10 } } }.
// Matching is longest-prefix on the model name, so "gpt-5-codex-mini" matches "gpt-5-codex" before "gpt-5".
// No table / no match → null (unknown), which the dashboard shows as "not priced" instead of a fake 0.
export type Rate = { input: number; cachedInput: number; output: number }
export type RateTable = { asOf: string | null; rates: Record<string, Rate> }

const EMPTY: RateTable = { asOf: null, rates: {} }
let cache: { path: string; mtimeMs: number; table: RateTable } | null = null

export function codexRatesPath(): string {
  return process.env.CODEX_RATES_FILE || resolve(process.cwd(), 'data', 'codex-rates.json')
}

export function loadCodexRates(path = codexRatesPath()): RateTable {
  try {
    if (!existsSync(path)) return EMPTY
    const mtimeMs = statSync(path).mtimeMs
    if (cache && cache.path === path && cache.mtimeMs === mtimeMs) return cache.table
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<RateTable>
    const table: RateTable = { asOf: typeof raw.asOf === 'string' ? raw.asOf : null, rates: raw.rates && typeof raw.rates === 'object' ? raw.rates : {} }
    cache = { path, mtimeMs, table }
    return table
  } catch {
    return EMPTY
  }
}

export function findRate(model: string, table: RateTable): Rate | null {
  const m = (model || '').toLowerCase()
  let best: { key: string; rate: Rate } | null = null
  for (const [key, rate] of Object.entries(table.rates)) {
    const k = key.toLowerCase()
    if (m.startsWith(k) && (!best || k.length > best.key.length)) best = { key: k, rate }
  }
  return best?.rate ?? null
}

// input tokens are the total prompt tokens (cached ones included, as the Responses API reports them).
export function estimateCost(
  model: string,
  t: { inputTokens: number; cacheReadTokens: number; outputTokens: number },
  table: RateTable = loadCodexRates(),
): number | null {
  const rate = findRate(model, table)
  if (!rate) return null
  if (!(rate.input > 0 || rate.output > 0)) return null // zero-filled placeholder (e.g. the shipped example) ≠ a price
  const uncached = Math.max(0, t.inputTokens - t.cacheReadTokens)
  return (uncached * rate.input + t.cacheReadTokens * rate.cachedInput + t.outputTokens * rate.output) / 1_000_000
}

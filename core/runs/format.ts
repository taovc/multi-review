import type { ProviderUsage } from './types'

// Human-readable cost/usage tail for progress events ("审核完成 · $1.364" or, when the provider gives no USD,
// "12.3k in / 2.1k out tokens").
export function formatUsageLabel(usage: ProviderUsage | null | undefined, fallbackCostUsd?: number): string {
  const cost = usage?.costUsd ?? (fallbackCostUsd && fallbackCostUsd > 0 ? fallbackCostUsd : null)
  if (cost != null) return `$${cost.toFixed(3)}${usage?.costSource === 'estimated' ? ' (est.)' : ''}`
  if (usage?.models.length) {
    const inTok = usage.models.reduce((a, m) => a + m.inputTokens, 0)
    const outTok = usage.models.reduce((a, m) => a + m.outputTokens, 0)
    return `${fmtTokens(inTok)} in / ${fmtTokens(outTok)} out tokens`
  }
  return 'cost unknown'
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

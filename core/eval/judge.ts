import type { GoldenLabel } from './golden'

// Pure matching of review findings against golden labels: same file path + enough title overlap.
// Deliberately no LLM judge in v1 (see the plan's over-engineering audit) — path + title fuzzy matching is
// transparent and reproducible; upgrade to a model judge only if the numbers prove too noisy.

export type JudgedFinding = { fid: string; severity: string; title: string; location: string | null; problem: string | null }
export type JudgeResult = {
  matches: Array<{ fid: string; labelId: string; score: number }>
  tp: number
  fp: number
  fn: number
  missedLabelIds: string[]
  unmatchedFids: string[]
}

const STOP = new Set(['the', 'a', 'an', 'of', 'in', 'on', 'to', 'for', 'and', 'or', 'is', 'are', 'be', 'with', 'when', 'not', 'no', 'this', 'that', 'it', 'as', 'at', 'by', 'from', 'into', 'than', 'can', 'may', 'should', 'will', 'does', 'do'])

export function pathOf(location: string | null | undefined): string {
  const s = String(location ?? '').trim()
  if (!s) return ''
  // "path:12", "path:12-20", "path#L12", "path (line 12)" → path
  const m = /^([^\s:#(]+)/.exec(s)
  return (m ? m[1]! : s).replace(/^\.\//, '').toLowerCase()
}

export function tokens(text: string): Set<string> {
  return new Set(
    String(text ?? '')
      .toLowerCase()
      .split(/[^a-z0-9一-鿿]+/)
      .flatMap((t) => (/[一-鿿]/.test(t) ? bigrams(t) : [t])) // CJK has no word boundaries: character bigrams
      .filter((t) => t.length > 1 && !STOP.has(t)),
  )
}

function bigrams(t: string): string[] {
  const chars = Array.from(t)
  return chars.length < 2 ? chars : chars.slice(0, -1).map((c, i) => c + chars[i + 1])
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  return inter / (a.size + b.size - inter)
}

// Similarity of one finding to one label: 0 when the paths differ (when both have one), else the best of
// title/title and title/problem token overlap.
export function similarity(f: JudgedFinding, l: GoldenLabel): number {
  const pf = pathOf(f.location)
  const pl = pathOf(l.location)
  if (pf && pl && pf !== pl && !pf.endsWith(pl) && !pl.endsWith(pf)) return 0
  const ft = tokens(`${f.title} ${f.problem ?? ''}`)
  const lt = tokens(`${l.title} ${l.problem}`)
  const s = Math.max(jaccard(tokens(f.title), tokens(l.title)), jaccard(ft, lt))
  // No path on either side: demand a stronger textual match.
  return pf && pl ? s : s * 0.8
}

export function judge(findings: JudgedFinding[], labels: GoldenLabel[], threshold = 0.3): JudgeResult {
  // Greedy best-first one-to-one assignment.
  const pairs: Array<{ fid: string; labelId: string; score: number }> = []
  for (const f of findings) for (const l of labels) { const score = similarity(f, l); if (score >= threshold) pairs.push({ fid: f.fid, labelId: l.id, score }) }
  pairs.sort((a, b) => b.score - a.score)
  const usedF = new Set<string>()
  const usedL = new Set<string>()
  const matches: JudgeResult['matches'] = []
  for (const p of pairs) {
    if (usedF.has(p.fid) || usedL.has(p.labelId)) continue
    usedF.add(p.fid); usedL.add(p.labelId); matches.push(p)
  }
  const missed = labels.filter((l) => !usedL.has(l.id))
  return {
    matches,
    tp: matches.length,
    fp: findings.length - matches.length,
    fn: missed.filter((l) => l.mustFind).length,
    missedLabelIds: missed.map((l) => l.id),
    unmatchedFids: findings.filter((f) => !usedF.has(f.fid)).map((f) => f.fid),
  }
}

export function prf(tp: number, fp: number, fn: number): { precision: number | null; recall: number | null; f1: number | null } {
  const precision = tp + fp ? tp / (tp + fp) : null
  const recall = tp + fn ? tp / (tp + fn) : null
  const f1 = precision != null && recall != null && precision + recall ? (2 * precision * recall) / (precision + recall) : null
  return { precision, recall, f1 }
}

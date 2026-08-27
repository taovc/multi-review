import { countRuns, recentRuns } from '~core/metrics/queries'

// One page of the run list for the dashboard (same filters as /api/metrics/overview): ?offset=&limit= (≤ 100).
// Both are clamped: a non-int64 number (1e300) bound to OFFSET is a SQLite datatype mismatch.
export default defineEventHandler((event) => {
  const q = getQuery(event)
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
  const int = (v: unknown, fallback: number) => { const n = Number(v); return Number.isFinite(n) ? Math.floor(n) : fallback }
  const to = str(q.to)
  const f = { projectId: str(q.projectId), from: str(q.from), to: to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? `${to}T23:59:59.999Z` : to }
  const limit = Math.min(100, Math.max(1, int(q.limit, 20)))
  const offset = Math.min(1_000_000, Math.max(0, int(q.offset, 0)))
  const d = db()
  return { rows: recentRuns(d, f, { limit, offset }), total: countRuns(d, f), offset, limit }
})

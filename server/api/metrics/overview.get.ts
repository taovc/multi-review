import { metricsOverview } from '~core/metrics/queries'

// Dashboard data: cost / tokens / precision / recheck / automation aggregates over the runs tables.
// ?projectId= narrows to one project; ?from=&to= are ISO date bounds on the run's created_at.
export default defineEventHandler((event) => {
  const q = getQuery(event)
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
  const to = str(q.to)
  return metricsOverview(db(), { projectId: str(q.projectId), from: str(q.from), to: to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? `${to}T23:59:59.999Z` : to })
})

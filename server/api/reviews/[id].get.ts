import { asc, eq, inArray } from 'drizzle-orm'
import { schema } from '~core/db/client'

// Everything for a single review: basics + findings (+rechecks) + posts + recent events. Serves the drawer's "AI review" tab.
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const d = db()

  const review = d.select().from(schema.reviews).where(eq(schema.reviews.id, id)).get()
  if (!review) throw createError({ statusCode: 404, statusMessage: 'review 不存在' })

  const findings = d
    .select()
    .from(schema.findings)
    .where(eq(schema.findings.reviewId, id))
    .orderBy(asc(schema.findings.sortOrder))
    .all()

  // Only query the rechecks belonging to this review's findings (no more full-table scan)
  const fids = findings.map((f) => f.id)
  const rechecks = fids.length
    ? d.select().from(schema.findingRechecks).where(inArray(schema.findingRechecks.findingId, fids)).all()
    : []
  const byFinding = new Map<string, any[]>()
  for (const r of rechecks) {
    if (!byFinding.has(r.findingId)) byFinding.set(r.findingId, [])
    byFinding.get(r.findingId)!.push(r)
  }

  const posts = d.select().from(schema.posts).where(eq(schema.posts.reviewId, id)).all()
  // The timeline shows only non-tool events plus the last few tool ones (there are too many tool events, and SSE already shows them live)
  const events = d.select().from(schema.events).where(eq(schema.events.reviewId, id)).all()
  const shown = events.filter((e) => e.kind !== 'tool').concat(events.filter((e) => e.kind === 'tool').slice(-40))

  return {
    review,
    findings: findings.map((f) => ({ ...f, rechecks: (byFinding.get(f.id) ?? []).sort((a, b) => a.round - b.round) })),
    posts,
    events: shown,
  }
})

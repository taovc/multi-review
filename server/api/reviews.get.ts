import { desc, eq, sql } from 'drizzle-orm'
import { schema } from '~core/db/client'

// List every review of a project + each one's H/M/L counts
export default defineEventHandler(async (event) => {
  const projectId = getQuery(event).projectId as string | undefined
  if (!projectId) throw createError({ statusCode: 400, statusMessage: '缺少 projectId' })
  const d = db()

  const reviews = d
    .select()
    .from(schema.reviews)
    .where(eq(schema.reviews.projectId, projectId))
    .orderBy(desc(schema.reviews.createdAt))
    .all()

  // Fetch the severity counts for all findings in one go
  const counts = d
    .select({
      reviewId: schema.findings.reviewId,
      severity: schema.findings.severity,
      n: sql<number>`count(*)`,
    })
    .from(schema.findings)
    .groupBy(schema.findings.reviewId, schema.findings.severity)
    .all()

  const byReview = new Map<string, { High: number; Medium: number; Low: number }>()
  for (const c of counts) {
    const cur = byReview.get(c.reviewId) ?? { High: 0, Medium: 0, Low: 0 }
    cur[c.severity as 'High' | 'Medium' | 'Low'] = Number(c.n)
    byReview.set(c.reviewId, cur)
  }

  return reviews.map((r) => ({
    ...r,
    counts: byReview.get(r.id) ?? { High: 0, Medium: 0, Low: 0 },
  }))
})

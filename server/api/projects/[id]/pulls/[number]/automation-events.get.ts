import { and, asc, eq } from 'drizzle-orm'
import { schema } from '~core/db/client'

// Automation workflow timeline for one PR (review created / reviewed / comment posted / fixed / pushed / rechecked / capped / converged…), oldest first.
export default defineEventHandler((event) => {
  const projectId = getRouterParam(event, 'id')!
  const prNumber = Number(getRouterParam(event, 'number'))
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'PR 编号不合法' })
  }
  const d = db()
  const events = d
    .select()
    .from(schema.automationEvents)
    .where(and(eq(schema.automationEvents.projectId, projectId), eq(schema.automationEvents.prNumber, prNumber)))
    .orderBy(asc(schema.automationEvents.ts))
    .all()
  return { events }
})

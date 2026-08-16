import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { schema } from '~core/db/client'

// Save the project-level automation config (the automation settings modal). authors/statuses are
// stored as JSON strings. Upsert (one row per project).
const Status = z.enum(['open', 'draft', 'merged', 'closed'])
const Body = z.object({
  masterEnabled: z.boolean(),
  reviewEnabled: z.boolean(),
  reviewMode: z.enum(['once', 'every_push']),
  reviewAuthors: z.array(z.string()).default([]),
  reviewStatuses: z.array(Status).default(['open']),
  fixEnabled: z.boolean(),
  fixAuthors: z.array(z.string()).default([]),
  fixStatuses: z.array(Status).default(['open']),
})

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const parsed = Body.safeParse(await readBody(event))
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: parsed.error.issues.map((i) => i.message).join('; ') })
  }
  const b = parsed.data
  const d = db()
  const project = d.select().from(schema.projects).where(eq(schema.projects.id, id)).get()
  if (!project) throw createError({ statusCode: 404, statusMessage: '项目不存在' })

  const now = new Date().toISOString()
  const row = {
    projectId: id,
    masterEnabled: b.masterEnabled,
    reviewEnabled: b.reviewEnabled,
    reviewMode: b.reviewMode,
    reviewAuthors: JSON.stringify(b.reviewAuthors),
    reviewStatuses: JSON.stringify(b.reviewStatuses),
    fixEnabled: b.fixEnabled,
    fixAuthors: JSON.stringify(b.fixAuthors),
    fixStatuses: JSON.stringify(b.fixStatuses),
    updatedAt: now,
  }
  const existing = d.select().from(schema.projectAutomation).where(eq(schema.projectAutomation.projectId, id)).get()
  if (existing) {
    d.update(schema.projectAutomation).set(row).where(eq(schema.projectAutomation.projectId, id)).run()
  } else {
    d.insert(schema.projectAutomation).values(row).run()
  }
  return { ok: true }
})

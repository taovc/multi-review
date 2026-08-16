import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { schema } from '~core/db/client'

// Edit a review: overall notes / manual status change (e.g. draft→ready_to_post)
const Body = z.object({
  globalNotes: z.string().optional(),
  reviewInstruction: z.string().optional(),
  status: z.enum(['draft', 'ready_to_post']).optional(),
})

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const parsed = Body.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: '参数错误' })

  const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() }
  if (parsed.data.globalNotes !== undefined) patch.globalNotes = parsed.data.globalNotes
  if (parsed.data.reviewInstruction !== undefined) patch.reviewInstruction = parsed.data.reviewInstruction
  if (parsed.data.status !== undefined) patch.status = parsed.data.status
  db().update(schema.reviews).set(patch).where(eq(schema.reviews.id, id)).run()
  return { ok: true }
})

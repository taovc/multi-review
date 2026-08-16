import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { schema } from '~core/db/client'

// Edit a single finding: tick "post to PR comment" / write notes
const Body = z.object({
  checked: z.boolean().optional(),
  notes: z.string().optional(),
})

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const parsed = Body.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: '参数错误' })

  const patch: Record<string, unknown> = {}
  if (parsed.data.checked !== undefined) patch.checked = parsed.data.checked
  if (parsed.data.notes !== undefined) patch.notes = parsed.data.notes
  if (Object.keys(patch).length) {
    const d = db()
    const row = d.select().from(schema.findings).where(eq(schema.findings.id, id)).get()
    d.update(schema.findings).set(patch).where(eq(schema.findings.id, id)).run()
    // A changed checkbox / note changes what gets posted → invalidate the preview cache (clear previewSig so it is regenerated next time) and bump review.updatedAt
    if (row) d.update(schema.reviews).set({ previewSig: null, updatedAt: new Date().toISOString() }).where(eq(schema.reviews.id, (row as any).reviewId)).run()
  }
  return { ok: true }
})

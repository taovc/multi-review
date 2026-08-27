import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { schema } from '~core/db/client'
import { hostOf } from '~core/host'

// Answer a pending permission / question / plan prompt of a live run.
const Body = z.discriminatedUnion('behavior', [
  z.object({ behavior: z.literal('allow'), always: z.boolean().optional(), message: z.string().max(2000).optional() }),
  z.object({ behavior: z.literal('deny'), message: z.string().max(2000).optional() }),
  z.object({ behavior: z.literal('answer'), answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])), message: z.string().max(2000).optional() }),
])

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const pid = getRouterParam(event, 'pid')!
  const parsed = Body.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: parsed.error.issues.map((i) => i.message).join('; ') })
  const ok = hostOf(id).answerPrompt(id, pid, parsed.data)
  if (!ok) {
    // Not parked in this process: it was answered already, expired on restart, or belongs to a closed session.
    const row = db().select().from(schema.permissionRequests).where(and(eq(schema.permissionRequests.id, pid), eq(schema.permissionRequests.runId, id))).get()
    throw createError({ statusCode: 409, statusMessage: row ? `prompt is ${row.status}, not pending` : 'prompt not found' })
  }
  return { ok: true }
})

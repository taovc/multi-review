import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { schema } from '~core/db/client'
import { hostOf } from '~core/host'

// Switch the permission mode of a live session mid-conversation (default / acceptEdits / plan / bypassPermissions),
// and/or the "allow dangerous commands" switch. Persisted on the run so the next turn starts with the same mode.
const Body = z.object({
  permissionMode: z.enum(['default', 'acceptEdits', 'plan', 'bypassPermissions']).optional(),
  allowDanger: z.boolean().optional(),
})

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const b = Body.parse((await readBody(event)) || {})
  const d = db()
  const patch: Record<string, unknown> = {}
  if (b.permissionMode) {
    patch.permissionMode = b.permissionMode
    await hostOf(id).setMode(id, b.permissionMode).catch((e) => { throw createError({ statusCode: 409, statusMessage: (e as Error).message }) })
  }
  if (b.allowDanger !== undefined) { patch.allowDanger = b.allowDanger; hostOf(id).setAllowDanger(id, b.allowDanger) }
  if (Object.keys(patch).length) d.update(schema.runs).set({ ...patch, updatedAt: new Date().toISOString() }).where(eq(schema.runs.id, id)).run()
  return { ok: true, live: hostOf(id).status(id) }
})

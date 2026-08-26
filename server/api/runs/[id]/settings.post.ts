import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { schema } from '~core/db/client'
import { hostOf } from '~core/host'
import { getRunOr404 } from '../../../utils/runContext'

// Change the model / effort of a session (the /model and /effort local commands): persisted on the run so the next
// resume uses them, and applied to the live host session when there is one.
const Body = z.object({ model: z.string().max(100).optional(), effort: z.string().max(20).optional() })

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const b = Body.parse((await readBody(event)) || {})
  const run = getRunOr404(id)
  const patch: Record<string, unknown> = {}
  if (b.model !== undefined) patch.model = b.model.trim() || null
  if (b.effort !== undefined) patch.effort = b.effort.trim() || null
  if (!Object.keys(patch).length) return { ok: true, model: run.model, effort: run.effort }
  db().update(schema.runs).set({ ...patch, updatedAt: new Date().toISOString() }).where(eq(schema.runs.id, id)).run()
  const applied = await hostOf(id).setModel(id, patch.model as string | null | undefined, patch.effort as string | null | undefined).catch(() => false)
  return { ok: true, model: patch.model ?? run.model, effort: patch.effort ?? run.effort, live: applied }
})

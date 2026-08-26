import { eq } from 'drizzle-orm'
import { schema } from '~core/db/client'
import { hostOf } from '~core/host'

// Delete one global session (global_turns go with it via FK cascade; foreign_keys is already ON in getDb).
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  // The worktree is going away: close the live host query so nothing keeps running (or resumes) inside it.
  await hostOf(id).close(id, 'discarded').catch(() => {})
  db().delete(schema.globalSessions).where(eq(schema.globalSessions.id, id)).run()
  return { ok: true }
})

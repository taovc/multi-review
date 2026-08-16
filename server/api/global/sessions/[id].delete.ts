import { eq } from 'drizzle-orm'
import { schema } from '~core/db/client'

// Delete one global session (global_turns go with it via FK cascade; foreign_keys is already ON in getDb).
export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')!
  db().delete(schema.globalSessions).where(eq(schema.globalSessions.id, id)).run()
  return { ok: true }
})

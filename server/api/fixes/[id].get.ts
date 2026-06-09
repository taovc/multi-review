import { eq } from 'drizzle-orm'
import { schema } from '~core/db/client'

// État d'un fix (status, stage, stats, tests, erreur).
export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')!
  const d = db()
  const fix = d.select().from(schema.fixes).where(eq(schema.fixes.id, id)).get()
  if (!fix) throw createError({ statusCode: 404, statusMessage: 'fix 不存在' })
  let steps: unknown = null
  try {
    steps = JSON.parse(fix.steps)
  } catch {
    /* garde brut si non parseable */
  }
  return { ...fix, steps }
})

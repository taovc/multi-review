import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { schema } from '~core/db/client'
import { addSkillVersion } from '~core/skillVersions'

const Body = z.object({ name: z.string().min(1).optional(), content: z.string().optional() })

// Renaming edits the row in place; a content change is recorded as a NEW immutable version (skills.content
// mirrors the current version), so past reviews keep pointing at the text they actually ran with.
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const b = Body.parse(await readBody(event))
  const d = db()
  if (b.name !== undefined) d.update(schema.skills).set({ name: b.name }).where(eq(schema.skills.id, id)).run()
  let version: { id: string; version: number; unchanged: boolean } | null = null
  if (b.content !== undefined) {
    try { version = addSkillVersion(d, schema, id, b.content, 'manual') }
    catch (e) { throw createError({ statusCode: 404, statusMessage: (e as Error).message }) }
  }
  return { ok: true, version }
})

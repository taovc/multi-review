import { nanoid } from 'nanoid'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { schema } from '~core/db/client'
import { ensureSkillVersion } from '~core/skillVersions'

// Create a skill (blank hand-written / pasted content). activate=true also sets it as the project's
// active skill.
const Body = z.object({
  name: z.string().min(1),
  content: z.string().default(''),
  source: z.enum(['manual', 'file', 'ai', 'optimized']).default('manual'),
  activate: z.boolean().default(false),
})

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const b = Body.parse(await readBody(event))
  const d = db()
  const row = {
    id: nanoid(),
    projectId: id,
    name: b.name,
    content: b.content,
    source: b.source,
    createdAt: new Date().toISOString(),
  }
  d.insert(schema.skills).values(row).run()
  ensureSkillVersion(d, schema, row) // version 1 snapshot
  if (b.activate) {
    d.update(schema.projects).set({ activeSkillId: row.id }).where(eq(schema.projects.id, id)).run()
  }
  return row
})

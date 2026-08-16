import { eq } from 'drizzle-orm'
import { schema } from '~core/db/client'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const d = db()
  // If the deleted skill is the active one, clear the project's activeSkillId
  const skill = d.select().from(schema.skills).where(eq(schema.skills.id, id)).get()
  if (skill) {
    const proj = d.select().from(schema.projects).where(eq(schema.projects.id, skill.projectId)).get()
    if (proj?.activeSkillId === id) {
      d.update(schema.projects).set({ activeSkillId: null }).where(eq(schema.projects.id, skill.projectId)).run()
    }
  }
  d.delete(schema.skills).where(eq(schema.skills.id, id)).run()
  return { ok: true }
})

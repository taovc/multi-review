import { eq } from 'drizzle-orm'
import { schema } from '~core/db/client'
import { getProjectAutomation } from '~core/automation/state'

// Read the project-level automation config (used by the automation dialog). Returns the "all off" default when nothing was ever saved. autoMaxRounds comes from the projects table (edited in the project config).
export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')!
  const d = db()
  const project = d.select().from(schema.projects).where(eq(schema.projects.id, id)).get()
  if (!project) throw createError({ statusCode: 404, statusMessage: '项目不存在' })
  const cfg = getProjectAutomation(d, schema, id)
  return { ...cfg, autoMaxRounds: project.autoMaxRounds ?? 2 }
})

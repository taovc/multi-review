import { desc, eq } from 'drizzle-orm'
import { schema } from '~core/db/client'

// The project's feature task list (most recently updated first).
export default defineEventHandler((event) => {
  const projectId = getRouterParam(event, 'id')!
  return db()
    .select()
    .from(schema.featureTasks)
    .where(eq(schema.featureTasks.projectId, projectId))
    .orderBy(desc(schema.featureTasks.updatedAt))
    .all()
})

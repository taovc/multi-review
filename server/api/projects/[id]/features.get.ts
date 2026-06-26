import { desc, eq } from 'drizzle-orm'
import { schema } from '~core/db/client'

// 项目的 feature 任务列表（最近更新在前）。
export default defineEventHandler((event) => {
  const projectId = getRouterParam(event, 'id')!
  return db()
    .select()
    .from(schema.featureTasks)
    .where(eq(schema.featureTasks.projectId, projectId))
    .orderBy(desc(schema.featureTasks.updatedAt))
    .all()
})

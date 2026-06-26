import { eq } from 'drizzle-orm'
import { schema } from '~core/db/client'

// 删除一段全局会话（global_turns 走 FK cascade 一起删；foreign_keys 已在 getDb 里 ON）。
export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')!
  db().delete(schema.globalSessions).where(eq(schema.globalSessions.id, id)).run()
  return { ok: true }
})

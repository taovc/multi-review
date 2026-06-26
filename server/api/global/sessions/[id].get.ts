import { asc, eq } from 'drizzle-orm'
import { schema } from '~core/db/client'

// 单段全局会话详情：会话行 + 对话轮（按 seq 升序）。加载历史时用。
export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')!
  const d = db()
  const session = d.select().from(schema.globalSessions).where(eq(schema.globalSessions.id, id)).get()
  if (!session) throw createError({ statusCode: 404, statusMessage: 'session 不存在' })
  const turns = d
    .select()
    .from(schema.globalTurns)
    .where(eq(schema.globalTurns.sessionId, id))
    .orderBy(asc(schema.globalTurns.seq))
    .all()
  return { session, turns }
})

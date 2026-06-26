import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { schema } from '~core/db/client'

// 重命名全局会话（标题）。
const Body = z.object({ title: z.string().max(200) })

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const { title } = Body.parse((await readBody(event)) || {})
  const d = db()
  const row = d.select().from(schema.globalSessions).where(eq(schema.globalSessions.id, id)).get()
  if (!row) throw createError({ statusCode: 404, statusMessage: 'session 不存在' })
  d.update(schema.globalSessions).set({ title: title.trim() || null }).where(eq(schema.globalSessions.id, id)).run()
  return { ok: true }
})

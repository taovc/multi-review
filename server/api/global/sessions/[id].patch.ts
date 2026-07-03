import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { schema } from '~core/db/client'

// 更新全局会话元信息。provider 是会话级选择，切换时不混用旧 provider 的模型名。
const Body = z.object({
  title: z.string().max(200).optional(),
  provider: z.enum(['claude', 'codex']).optional(),
  model: z.string().nullable().optional(),
  effort: z.string().nullable().optional(),
})

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const body = Body.parse((await readBody(event)) || {})
  const d = db()
  const row = d.select().from(schema.globalSessions).where(eq(schema.globalSessions.id, id)).get()
  if (!row) throw createError({ statusCode: 404, statusMessage: 'session 不存在' })
  const patch: Record<string, unknown> = {}
  if ('title' in body) patch.title = body.title?.trim() || null
  if ('provider' in body) {
    patch.provider = body.provider
    if (!('model' in body)) patch.model = null
  }
  if ('model' in body) patch.model = body.model?.trim() || null
  if ('effort' in body) patch.effort = body.effort?.trim() || null
  if (Object.keys(patch).length) d.update(schema.globalSessions).set(patch).where(eq(schema.globalSessions.id, id)).run()
  return { ok: true }
})

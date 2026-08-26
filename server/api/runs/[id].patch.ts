import { eq } from 'drizzle-orm'
import { existsSync } from 'node:fs'
import { z } from 'zod'
import { schema } from '~core/db/client'
import { getRunOr404 } from '../../utils/runContext'

// Rename a session, move a cwd session to another directory, or change provider/model/effort before a native session exists.
const Body = z.object({
  title: z.string().max(200).optional(),
  cwd: z.string().optional(),
  provider: z.enum(['claude', 'codex']).optional(),
  model: z.string().nullable().optional(),
  effort: z.string().nullable().optional(),
})

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const b = Body.parse((await readBody(event)) || {})
  const run = getRunOr404(id)
  const patch: Record<string, unknown> = {}
  if (b.title !== undefined) patch.title = b.title.trim() || null
  if (b.cwd !== undefined) {
    if (run.workspaceType !== 'cwd') throw createError({ statusCode: 400, statusMessage: '只有工作目录会话可以改目录' })
    if (!existsSync(b.cwd)) throw createError({ statusCode: 400, statusMessage: `目录不存在: ${b.cwd}` })
    patch.workspacePath = b.cwd
  }
  if (b.provider !== undefined || b.model !== undefined || b.effort !== undefined) {
    if (run.claudeSessionId || run.codexThreadId) throw createError({ statusCode: 409, statusMessage: '会话已经开始，不能再换 provider/模型（新开一个会话）' })
    if (b.provider !== undefined) patch.provider = b.provider
    if (b.model !== undefined) patch.model = b.model
    if (b.effort !== undefined) patch.effort = b.effort
  }
  if (Object.keys(patch).length) db().update(schema.runs).set({ ...patch, updatedAt: new Date().toISOString() }).where(eq(schema.runs.id, id)).run()
  return getRunOr404(id)
})

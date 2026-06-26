import { nanoid } from 'nanoid'
import { z } from 'zod'
import { schema } from '~core/db/client'

// 新建一段全局会话（空会话，session id 在第一轮对话时由 runner 回填）。
const Body = z.object({
  provider: z.enum(['claude', 'codex']).optional(),
  model: z.string().optional(),
  cwd: z.string().optional(),
  title: z.string().max(200).optional(),
})

export default defineEventHandler(async (event) => {
  const b = Body.parse((await readBody(event).catch(() => ({}))) || {})
  const now = new Date().toISOString()
  const row = {
    id: nanoid(),
    title: b.title?.trim() || null,
    provider: (b.provider ?? 'claude') as 'claude' | 'codex',
    model: b.model?.trim() || null,
    cwd: b.cwd?.trim() || null,
    sessionId: null,
    codexSessionId: null,
    status: 'idle' as const,
    error: null,
    createdAt: now,
    lastUsedAt: now,
  }
  db().insert(schema.globalSessions).values(row).run()
  return row
})

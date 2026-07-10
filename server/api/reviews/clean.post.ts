import { eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { schema } from '~core/db/client'
import { removeWorktree } from '~core/git/worktree'

// 按类别清理任务：merged=已合并的 PR；posted=已发评论的。各自独立，前端分两个按钮 + 各自确认。
const Body = z.object({
  projectId: z.string().min(1),
  mode: z.enum(['merged', 'posted']),
})

export default defineEventHandler(async (event) => {
  const parsed = Body.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: '参数错误（需要 projectId + mode）' })
  const { projectId, mode } = parsed.data
  const cfg = useRuntimeConfig()
  const d = db()

  const project = d.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()
  const rows = d.select().from(schema.reviews).where(eq(schema.reviews.projectId, projectId)).all()
  const ids = rows
    .filter((r) => (mode === 'merged' ? r.prState === 'merged' : r.status === 'posted'))
    .map((r) => r.id)

  if (ids.length) {
    for (const rid of ids) await removeWorktree(project?.localPath ?? null, cfg.reposDir as string, rid)
    d.delete(schema.reviews).where(inArray(schema.reviews.id, ids)).run()
  }
  return { deleted: ids.length }
})

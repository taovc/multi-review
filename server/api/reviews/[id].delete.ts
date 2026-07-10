import { eq } from 'drizzle-orm'
import { schema } from '~core/db/client'
import { removeWorktree } from '~core/git/worktree'
import { optOutPr } from '~core/automation/state'

// 删除单个审核任务：同步清理它的 worktree（只删本地任务，GitHub 评论不动）
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const cfg = useRuntimeConfig()
  const d = db()

  const review = d.select().from(schema.reviews).where(eq(schema.reviews.id, id)).get()
  if (review) {
    const project = d.select().from(schema.projects).where(eq(schema.projects.id, review.projectId)).get()
    await removeWorktree(project?.localPath ?? null, cfg.reposDir as string, id)
    // 删任务即退出自动化：标该 PR opt-out，防全局配置在下一轮把它复活（直到用户手动再开）
    optOutPr(d, schema, review.projectId, review.prNumber, new Date().toISOString())
  }
  d.delete(schema.reviews).where(eq(schema.reviews.id, id)).run()
  return { ok: true }
})

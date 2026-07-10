import { eq } from 'drizzle-orm'
import { schema } from '~core/db/client'
import { removeWorktree } from '~core/git/worktree'
import { isChatting } from '~core/fix/pipeline'
import { optOutPr } from '~core/automation/state'

// 删除修复任务：清 worktree + 删行（fix_findings 走 FK cascade 一起删）。
// 进行中 / 对话中不可删（worktree 正被 agent 或 Node 的 git 操作占用）。
// 删行 = 列表里消失，该 PR 之后可重新建修复任务（和审核任务的删除一致）。
// 注：conflict 可以 discard（连同 worktree 整个丢弃，MERGE_HEAD 一起没），区别于只删 worktree。
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const cfg = useRuntimeConfig()
  const d = db()
  const fix = d.select().from(schema.fixes).where(eq(schema.fixes.id, id)).get()
  if (!fix) throw createError({ statusCode: 404, statusMessage: 'fix 不存在' })
  if (fix.status === 'pushing') {
    throw createError({ statusCode: 409, statusMessage: '上传进行中，请等它完成' })
  }
  if (isChatting(id)) throw createError({ statusCode: 409, statusMessage: '对话进行中，请等它完成或停止' })

  const project = d.select().from(schema.projects).where(eq(schema.projects.id, fix.projectId)).get()
  await removeWorktree(project?.localPath ?? null, cfg.reposDir as string, id).catch(() => {})
  // 删修复任务即退出自动化（同审核删除）：标该 PR opt-out，防被全局配置复活
  optOutPr(d, schema, fix.projectId, fix.prNumber, new Date().toISOString())
  d.delete(schema.fixes).where(eq(schema.fixes.id, id)).run()
  return { ok: true, status: 'deleted' }
})

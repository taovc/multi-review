import { eq } from 'drizzle-orm'
import { rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { schema } from '~core/db/client'
import { removeWorktree } from '~core/git/worktree'
import { isFeatureBusy } from '~core/feature/pipeline'

// 删除 feature 任务：清 worktree + 删 issue 配图目录 + 删行（turns/events 走 FK cascade）。进行中不可删。
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const cfg = useRuntimeConfig()
  const d = db()
  const task = d.select().from(schema.featureTasks).where(eq(schema.featureTasks.id, id)).get()
  if (!task) throw createError({ statusCode: 404, statusMessage: 'feature 任务不存在' })
  if (isFeatureBusy(id)) throw createError({ statusCode: 409, statusMessage: '正在处理中，请等它完成或停止' })

  const project = d.select().from(schema.projects).where(eq(schema.projects.id, task.projectId)).get()
  // worktree 以 taskId 为 key（同 fix），removeWorktree 注销 + 删目录
  await removeWorktree(project?.localPath ?? null, cfg.reposDir as string, id).catch(() => {})
  // 清掉这个任务下载的 issue/PR 配图（落在 <data>/issue-assets/<taskId>）
  await rm(resolve(process.cwd(), dirname(cfg.dbPath as string), 'issue-assets', id), { recursive: true, force: true }).catch(() => {})
  d.delete(schema.featureTasks).where(eq(schema.featureTasks.id, id)).run()
  return { ok: true, status: 'deleted' }
})

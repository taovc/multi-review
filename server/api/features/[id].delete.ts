import { eq } from 'drizzle-orm'
import { rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { schema } from '~core/db/client'
import { claudeHost } from '~core/host/claudeHost'
import { removeWorktree } from '~core/git/worktree'
import { isFeatureBusy } from '~core/feature/pipeline'

// Delete a feature task: clear the worktree + remove the issue image directory + delete the row (turns/events go through the FK cascade). Can't be deleted while it's running.
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  // The worktree is going away: close the live host query so nothing keeps running (or resumes) inside it.
  await claudeHost.close(id, 'discarded').catch(() => {})
  const cfg = useRuntimeConfig()
  const d = db()
  const task = d.select().from(schema.featureTasks).where(eq(schema.featureTasks.id, id)).get()
  if (!task) throw createError({ statusCode: 404, statusMessage: 'feature 任务不存在' })
  if (isFeatureBusy(id)) throw createError({ statusCode: 409, statusMessage: '正在处理中，请等它完成或停止' })

  const project = d.select().from(schema.projects).where(eq(schema.projects.id, task.projectId)).get()
  // The worktree is keyed by taskId (same as fix); removeWorktree deregisters it + deletes the directory
  await removeWorktree(project?.localPath ?? null, cfg.reposDir as string, id, { location: cfg.worktreeLocation as string, worktreePath: task.worktreePath }).catch(() => {})
  // Clear the issue/PR images this task downloaded (they live in <data>/issue-assets/<taskId>)
  await rm(resolve(process.cwd(), dirname(cfg.dbPath as string), 'issue-assets', id), { recursive: true, force: true }).catch(() => {})
  d.delete(schema.featureTasks).where(eq(schema.featureTasks.id, id)).run()
  return { ok: true, status: 'deleted' }
})

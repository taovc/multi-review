import { eq } from 'drizzle-orm'
import { rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { schema } from '~core/db/client'
import { hostOf } from '~core/host'
import { removeWorktree } from '~core/git/worktree'
import { isRunBusy } from '~core/runs/session'
import { optOutPr } from '~core/automation/state'
import { getRunOr404 } from '../../utils/runContext'

// Delete a session run: close the live host session, remove its worktree (PR / feature sessions), drop the downloaded
// issue assets and delete the row (turns / events / prompts / usage cascade). A PR session deletion opts the PR out
// of automation (same rule as deleting a review). Not allowed while a turn or an upload is running.
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const run = getRunOr404(id)
  if (isRunBusy(id)) throw createError({ statusCode: 409, statusMessage: '对话进行中，请等它完成或停止' })
  if (run.busyAction === 'pushing') throw createError({ statusCode: 409, statusMessage: '上传进行中，请等它完成' })
  await hostOf(id).close(id, 'deleted').catch(() => {})
  const cfg = useRuntimeConfig()
  const d = db()
  if (run.workspaceType !== 'cwd') {
    const project = run.projectId ? d.select().from(schema.projects).where(eq(schema.projects.id, run.projectId)).get() : null
    await removeWorktree(project?.localPath ?? null, cfg.reposDir as string, id, { location: cfg.worktreeLocation as string, worktreePath: run.workspacePath }).catch(() => {})
    if (run.workspaceType === 'pr_worktree' && run.projectId && run.prNumber) optOutPr(d, schema, run.projectId, run.prNumber, new Date().toISOString())
  }
  await rm(resolve(process.cwd(), dirname(cfg.dbPath as string), 'issue-assets', id), { recursive: true, force: true }).catch(() => {})
  d.delete(schema.runs).where(eq(schema.runs.id, id)).run()
  return { ok: true, status: 'deleted' }
})

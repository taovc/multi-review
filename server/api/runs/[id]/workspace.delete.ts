import { eq } from 'drizzle-orm'
import { schema } from '~core/db/client'
import { hostOf } from '~core/host'
import { removeWorktree } from '~core/git/worktree'
import { isRunBusy } from '~core/runs/session'
import { getPrAutomationRow, pausePr } from '~core/automation/state'
import { getRunOr404 } from '../../../utils/runContext'

// Remove the session's worktree but keep the conversation row: the next message recreates the worktree on the same
// branch and starts a fresh native session (the old one remembered a directory that no longer exists).
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const run = getRunOr404(id)
  if (run.workspaceType === 'cwd') throw createError({ statusCode: 400, statusMessage: '工作目录会话没有 worktree' })
  if (isRunBusy(id)) throw createError({ statusCode: 409, statusMessage: '对话进行中，请等它完成或停止' })
  if (run.busyAction === 'pushing') throw createError({ statusCode: 409, statusMessage: '上传进行中，请等它完成' })
  await hostOf(id).close(id, 'worktree removed').catch(() => {})
  const cfg = useRuntimeConfig()
  const d = db()
  const project = run.projectId ? d.select().from(schema.projects).where(eq(schema.projects.id, run.projectId)).get() : null
  await removeWorktree(project?.localPath ?? null, cfg.reposDir as string, id, { location: cfg.worktreeLocation as string, worktreePath: run.workspacePath }).catch(() => {})
  const now = new Date().toISOString()
  d.update(schema.runs).set({ workspacePath: null, baseHeadSha: null, fixHeadSha: null, claudeSessionId: null, codexThreadId: null, uploadState: 'none', updatedAt: now }).where(eq(schema.runs.id, id)).run()
  if (run.workspaceType === 'pr_worktree' && run.projectId && run.prNumber && getPrAutomationRow(d, schema, run.projectId, run.prNumber)) pausePr(d, schema, run.projectId, run.prNumber, now)
  return { ok: true }
})

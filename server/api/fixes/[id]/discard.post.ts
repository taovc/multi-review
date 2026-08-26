import { eq } from 'drizzle-orm'
import { schema } from '~core/db/client'
import { claudeHost } from '~core/host/claudeHost'
import { removeWorktree } from '~core/git/worktree'
import { isChatting } from '~core/fix/pipeline'
import { optOutPr } from '~core/automation/state'

// Delete a fix task: clean up the worktree + delete the row (fix_findings goes with it via FK cascade).
// Not deletable while running / chatting (the worktree is held by the agent or by a git operation from Node).
// Deleting the row = it disappears from the list, and a new fix task can be created for that PR later (same as deleting a review task).
// Note: a conflict can be discarded (the whole worktree goes with it, MERGE_HEAD included), unlike removing only the worktree.
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  // The worktree is going away: close the live host query so nothing keeps running (or resumes) inside it.
  await claudeHost.close(id, 'discarded').catch(() => {})
  const cfg = useRuntimeConfig()
  const d = db()
  const fix = d.select().from(schema.fixes).where(eq(schema.fixes.id, id)).get()
  if (!fix) throw createError({ statusCode: 404, statusMessage: 'fix 不存在' })
  if (fix.status === 'pushing') {
    throw createError({ statusCode: 409, statusMessage: '上传进行中，请等它完成' })
  }
  if (isChatting(id)) throw createError({ statusCode: 409, statusMessage: '对话进行中，请等它完成或停止' })

  const project = d.select().from(schema.projects).where(eq(schema.projects.id, fix.projectId)).get()
  await removeWorktree(project?.localPath ?? null, cfg.reposDir as string, id, { location: cfg.worktreeLocation as string, worktreePath: fix.worktreePath }).catch(() => {})
  // Deleting a fix task means opting out of automation (same as deleting a review): mark the PR opt-out so the global config can't revive it
  optOutPr(d, schema, fix.projectId, fix.prNumber, new Date().toISOString())
  d.delete(schema.fixes).where(eq(schema.fixes.id, id)).run()
  return { ok: true, status: 'deleted' }
})

import { eq } from 'drizzle-orm'
import { schema } from '~core/db/client'
import { claudeHost } from '~core/host/claudeHost'
import { removeWorktree } from '~core/git/worktree'
import { isChatting } from '~core/fix/pipeline'
import { getPrAutomationRow, pausePr } from '~core/automation/state'

// Only deletes the local worktree directory to free disk space, keeping the fix row and its results
// (unlike discard, which deletes the row too). Use this to clean up leftovers after a PR is merged.
// Cannot delete while running / chatting (the agent is using the worktree).
// After deleting we clear the three worktree-related fields: worktree_path (the directory) +
// base_head_sha (the diff baseline) + fix_head_sha (the local commit, which is gone with the directory
// when it was never pushed; keeping it would make hasUnpushed report falsely).
// We also clear both session ids (session_id=claude / codex_session_id=codex): with the workspace gone,
// the code context the conversation was based on is gone too, so the next chat should start from a clean
// session rather than resuming an old one that "remembers" changes which no longer exist.
// last_push_sha is kept (history of what was pushed, still used by reply). The next verification/fix run
// has ensureWorktree rebuild it from the branch.
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
  const now = new Date().toISOString()
  d.update(schema.fixes)
    .set({ worktreePath: null, baseHeadSha: null, fixHeadSha: null, sessionId: null, codexSessionId: null, updatedAt: now })
    .where(eq(schema.fixes.id, id))
    .run()
  // With the worktree gone, an auto-fix push would only hit a precondition error. If this PR has automation
  // state, turn it off here (clear pendingFix + both switches) so the engine sees both-off next round and stops
  // cleanly instead of raising a misleading push_error. The user can re-enable it any time (re-enabling resets
  // and reruns, rebuilding the worktree).
  if (getPrAutomationRow(d, schema, fix.projectId, fix.prNumber)) {
    pausePr(d, schema, fix.projectId, fix.prNumber, now)
  }
  return { ok: true }
})

import { schema } from '~core/db/client'
import { stopRun } from '~core/runs/session'
import { pausePr } from '~core/automation/state'
import { getRunOr404 } from '../../../utils/runContext'

// Stop the turn in progress. Text already produced and edits already on disk are kept. For a PR session the user
// stopping it = taking over the PR: its automation switches are paused so the engine does not barge back in.
export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')!
  const run = getRunOr404(id)
  const ok = stopRun(id)
  if (run.workspaceType === 'pr_worktree' && run.projectId && run.prNumber) {
    try { pausePr(db(), schema, run.projectId, run.prNumber, new Date().toISOString()) } catch { /* a failed pause never blocks the stop */ }
  }
  return { ok, stopped: ok }
})

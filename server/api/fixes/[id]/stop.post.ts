import { eq } from 'drizzle-orm'
import { schema } from '~core/db/client'
import { stopFixChat } from '~core/fix/pipeline'
import { pausePr } from '~core/automation/state'

// Stop the turn currently being generated: for Claude kill the child process, for Codex abort the current SDK turn.
// Text already generated and changes already written to the worktree are kept; upload/commit still has to be triggered manually by the user on the upload path.
// The user stopping it = taking over this PR: turn off its auto-review/auto-fix switches so the engine doesn't barge back in on the next round (no human/machine tug-of-war).
export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')!
  const ok = stopFixChat(id)
  try {
    const d = db()
    const fix = d.select().from(schema.fixes).where(eq(schema.fixes.id, id)).get()
    if (fix) pausePr(d, schema, fix.projectId, fix.prNumber, new Date().toISOString())
  } catch { /* a failed pause sync doesn't affect the stop itself */ }
  return { ok, stopped: ok }
})

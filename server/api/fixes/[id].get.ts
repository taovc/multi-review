import { asc, eq } from 'drizzle-orm'
import { existsSync } from 'node:fs'
import { schema } from '~core/db/client'
import { fixChangesStat, hasUploadable } from '~core/fix/changes'
import { computeFixNextStatus } from '~core/fix/status'
import { isChatting } from '~core/fix/pipeline'

// Fix task detail: the fix row + chat turns + event log + live change stats. Chat-only version (no findings).
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const d = db()
  const fix = d.select().from(schema.fixes).where(eq(schema.fixes.id, id)).get()
  if (!fix) throw createError({ statusCode: 404, statusMessage: 'fix 不存在' })
  const project = d.select().from(schema.projects).where(eq(schema.projects.id, fix.projectId)).get()
  const turns = d
    .select()
    .from(schema.fixTurns)
    .where(eq(schema.fixTurns.fixId, id))
    .orderBy(asc(schema.fixTurns.seq))
    .all()
  const events = d
    .select({ ts: schema.fixEvents.ts, kind: schema.fixEvents.kind, message: schema.fixEvents.message })
    .from(schema.fixEvents)
    .where(eq(schema.fixEvents.fixId, id))
    .orderBy(asc(schema.fixEvents.ts))
    .all()

  // Self-heal orphaned streaming turns: a streaming turn exists ⟺ isChatting is true (the job takes the lock
  // synchronously before creating the turn); the only exception is a dead process (restart/kill — the in-memory
  // lock is gone but the turn in the DB is still streaming). In that case close it out as stopped and move the
  // fix to ready/open based on whether anything is uploadable (the streaming turn is the latest one, overriding
  // any leftover error). The frontend calls this on every load (opening the drawer / after clicking stop), so a
  // refresh or a stop click clears the "stuck on Working, stop does nothing" state.
  const last = turns[turns.length - 1] as any
  if (last && last.role === 'assistant' && last.status === 'streaming' && !isChatting(id) && fix.status !== 'pushing') {
    let up = { dirty: false, ahead: false }
    if (fix.worktreePath && existsSync(fix.worktreePath)) {
      up = await hasUploadable(fix.worktreePath, fix.branch).catch(() => ({ dirty: false, ahead: false }))
    }
    const next = computeFixNextStatus({ dirty: up.dirty, ahead: up.ahead, currentStatus: fix.status })
    d.update(schema.fixTurns).set({ status: 'stopped' }).where(eq(schema.fixTurns.id, last.id)).run()
    d.update(schema.fixes).set({ status: next, error: null, updatedAt: new Date().toISOString() }).where(eq(schema.fixes.id, id)).run()
    last.status = 'stopped'
    ;(fix as any).status = next
    ;(fix as any).error = null
  }

  // Don't touch the worktree while a chat/upload is in flight (it races the agent; git status would read a half-done state)
  const busy = fix.status === 'pushing' || isChatting(id)
  // "has uploadable changes" = the worktree is dirty (Claude edited but hasn't committed) or local HEAD is ahead of the last push (leftover committed-but-unpushed work)
  let hasUnpushed = !!fix.fixHeadSha && fix.fixHeadSha !== fix.lastPushSha
  let stat = { filesChanged: fix.filesChanged ?? 0, additions: fix.additions ?? 0, deletions: fix.deletions ?? 0 }
  if (!busy && fix.worktreePath && existsSync(fix.worktreePath)) {
    const [up, s] = await Promise.all([
      hasUploadable(fix.worktreePath, fix.branch).catch(() => ({ dirty: false, ahead: false })),
      fixChangesStat(fix.worktreePath).catch(() => stat),
    ])
    hasUnpushed = up.dirty || up.ahead // working tree dirty, or local ahead of origin (including commits Claude made itself)
    stat = s
  }

  const prUrl = project ? `https://github.com/${project.repo}/pull/${fix.prNumber}` : null
  return {
    fix: { ...fix, ...stat }, // includes worktreePath / baseRef / lastPushSha / lastActionKind; the stats use the last-changes definition
    turns,
    events,
    hasUnpushed,
    prUrl,
    // uploaded before → link to that commit
    commitUrl: project && fix.lastPushSha ? `https://github.com/${project.repo}/pull/${fix.prNumber}/commits/${fix.lastPushSha}` : null,
  }
})

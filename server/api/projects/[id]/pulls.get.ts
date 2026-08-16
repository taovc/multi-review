import { existsSync } from 'node:fs'
import { eq } from 'drizzle-orm'
import { schema } from '~core/db/client'
import { listPulls, getCurrentUserLogin } from '~core/github/gh'
import { getProjectAutomation, getPrAutomationMap, pullStatusKey } from '~core/automation/state'
import { effectiveReviewOn, effectiveFixOnGuarded } from '~core/automation/decide'

const WORKTREE_STALE_DAYS = 30

// Fetch the project repo's PRs page by page (GraphQL cursor), flagging which ones already have a
// review task.
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const query = getQuery(event)
  const state = (query.state as string) || 'open'
  const validState = (['open', 'closed', 'merged', 'all'] as const).includes(state as any)
    ? (state as 'open' | 'closed' | 'merged' | 'all')
    : 'open'
  const first = Math.min(Number(query.first) || 20, 100) // fetch enough at once for the frontend to filter and paginate locally (GraphQL caps at 100)
  const after = (query.after as string) || null

  const d = db()
  const project = d.select().from(schema.projects).where(eq(schema.projects.id, id)).get()
  if (!project) throw createError({ statusCode: 404, statusMessage: '项目不存在' })

  let page
  try {
    page = await listPulls(project.repo, validState, first, after)
  } catch (e) {
    throw createError({ statusCode: 502, statusMessage: (e as Error).message })
  }

  // Review tasks: carry "the head seen at review time" and "the head at comment time" → derive
  // "author updated"
  const tasks = d
    .select({
      id: schema.reviews.id,
      prNumber: schema.reviews.prNumber,
      status: schema.reviews.status,
      headSha: schema.reviews.headSha,
      lastPostSha: schema.reviews.lastPostSha,
    })
    .from(schema.reviews)
    .where(eq(schema.reviews.projectId, id))
    .all()
  const taskByPr = new Map(tasks.map((t) => [t.prNumber, t]))

  // Fix tasks: take the latest non-discarded one per PR; carry pushedAt + reviewsAtPush → derive
  // "reviewer updated"
  const fixRows = d
    .select({
      id: schema.fixes.id,
      prNumber: schema.fixes.prNumber,
      status: schema.fixes.status,
      createdAt: schema.fixes.createdAt,
      updatedAt: schema.fixes.updatedAt,
      pushedAt: schema.fixes.pushedAt,
      reviewsAtPush: schema.fixes.reviewsAtPush,
      worktreePath: schema.fixes.worktreePath,
    })
    .from(schema.fixes)
    .where(eq(schema.fixes.projectId, id))
    .all()
  const fixByPr = new Map<number, (typeof fixRows)[number]>()
  for (const f of fixRows.sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (f.status === 'discarded') continue
    fixByPr.set(f.prNumber, f) // later writes overwrite → the latest one wins
  }
  // "Conversation in progress": the most recent assistant turn is still streaming = the AI is working.
  // This sits outside the state machine (chat never changes fixes.status), so the list derives the
  // "chatting" badge from it.
  // On restart the recover plugin resets streaming turns to stopped, so no stale streaming shows up
  // here.
  const chattingFixIds = new Set<string>(
    d.select({ fixId: schema.fixTurns.fixId })
      .from(schema.fixTurns)
      .where(eq(schema.fixTurns.status, 'streaming' as any))
      .all()
      .map((r: any) => r.fixId),
  )

  // Automation: project-level config + each PR's effective switches / runtime state (feeds the two
  // switches in the PR drawer and the list's "paused" hint)
  const autoCfg = getProjectAutomation(d, schema, id)
  const autoRowByPr = getPrAutomationMap(d, schema, id) // fetch all at once, avoiding N+1 lookups inside .map()
  const autoMaxRounds = project.autoMaxRounds ?? 2
  const autoCooldownMin = project.autoCooldownMinutes ?? 5
  const nowMs = Date.now()
  const me = await getCurrentUserLogin().catch(() => null) // default for the auto-fix author allowlist (same rule as the engine)

  return {
    pulls: page.pulls.map((p) => {
      const task = taskByPr.get(p.number)
      const fix = fixByPr.get(p.number)
      // Effective automation switches: a per-PR override wins, otherwise inherit the project config
      // plus the author/status filters
      const autoRow = autoRowByPr.get(p.number) ?? null
      const prKey = { author: p.author, status: pullStatusKey(p) }
      const autoReviewOn = effectiveReviewOn(autoCfg, autoRow, prKey)
      const autoFixOn = effectiveFixOnGuarded(autoCfg, autoRow, prKey, me)
      // Author updated: the PR head moved past the sha I have "seen". The baseline is review.headSha —
      // both review and recheck advance it, so once a recheck has looked at the new commits the dot
      // clears by itself, and only a push after that recheck baseline lights it up again (same rule
      // as the drawer / refresh).
      // Side effect: after the first review the dot lights up on an author push even before any
      // comment was posted — which is exactly what "there are changes I haven't seen" means.
      const authorUpdated = !!task?.headSha && !!p.headSha && p.headSha !== task.headSha
      // Reviewer updated: after I pushed a fix the PR's review count grew = somebody submitted another
      // review.
      // Note: reviewsCount includes bot/CI reviews, so a CI auto-review after the push counts too
      // (acceptable for a local single-user tool).
      const reviewerUpdated = !!fix?.pushedAt && fix.reviewsAtPush != null && p.reviewsCount > fix.reviewsAtPush
      // Whether the local fix worktree is still on disk (review worktrees are thrown away right after
      // use and never linger; only fix ones survive until push/discard).
      // This is what finds leftovers to clean up after a merge. Check the actual directory, not just
      // the DB field (the DB may hold a path whose directory was deleted by hand).
      const hasWorktree = !!fix?.worktreePath && existsSync(fix.worktreePath)
      const fixUpdatedMs = fix?.updatedAt ? Date.parse(fix.updatedAt) : Number.NaN
      const worktreeStale = hasWorktree && (
        prKey.status === 'merged'
        || prKey.status === 'closed'
        || (Number.isFinite(fixUpdatedMs) && fixUpdatedMs < nowMs - WORKTREE_STALE_DAYS * 24 * 60 * 60 * 1000)
      )
      // Cooling down: the head the engine saw is still the current head, and first-seen time +
      // cooldown hasn't elapsed → let the UI show "cooling down, X left"
      let autoCoolingUntil: string | null = null
      if (autoCooldownMin > 0 && (autoReviewOn || autoFixOn) && autoRow?.headSeenSha && autoRow.headSeenSha === p.headSha && autoRow.headSeenAt) {
        const until = Date.parse(autoRow.headSeenAt) + autoCooldownMin * 60_000
        if (until > nowMs) autoCoolingUntil = new Date(until).toISOString()
      }
      return {
        ...p,
        hasTask: !!task, taskId: task?.id ?? null, taskStatus: task?.status ?? null,
        fixId: fix?.id ?? null, fixStatus: fix?.status ?? null,
        fixChatting: fix ? chattingFixIds.has(fix.id) : false,
        authorUpdated, reviewerUpdated, hasWorktree, worktreeStale,
        autoReviewOn, autoFixOn, autoNote: autoRow?.note ?? null, autoRound: autoRow?.round ?? 0, autoMaxRounds, autoCoolingUntil,
      }
    }),
    totalCount: page.totalCount,
    hasNextPage: page.hasNextPage,
    endCursor: page.endCursor,
  }
})

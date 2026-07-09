import { existsSync } from 'node:fs'
import { eq } from 'drizzle-orm'
import { schema } from '~core/db/client'
import { listPulls, getCurrentUserLogin } from '~core/github/gh'
import { getProjectAutomation, getPrAutomationMap, pullStatusKey } from '~core/automation/state'
import { effectiveReviewOn, effectiveFixOnGuarded } from '~core/automation/decide'

const WORKTREE_STALE_DAYS = 30

// 分页拉该项目仓库的 PR（GraphQL cursor），标注哪些已建审核任务。
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const query = getQuery(event)
  const state = (query.state as string) || 'open'
  const validState = (['open', 'closed', 'merged', 'all'] as const).includes(state as any)
    ? (state as 'open' | 'closed' | 'merged' | 'all')
    : 'open'
  const first = Math.min(Number(query.first) || 20, 100) // 前端一次拉够做本地过滤+分页（GraphQL 上限 100）
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

  // 审核任务：带上「审核时看的 head」「发评论时的 head」→ 算「作者已更新」
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

  // 修复任务：每个 PR 取最新一个未废弃的；带 pushedAt + reviewsAtPush → 算「审核已更新」
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
    fixByPr.set(f.prNumber, f) // 后写覆盖 → 留下最新
  }
  // 「对话进行中」：最近一条 assistant 轮还在 streaming = AI 正在干活。
  // 这是状态机之外的旁路（chat 不改 fixes.status），所以列表用它派生「对话中」角标。
  // 重启会被 recover 插件把 streaming 轮重置成 stopped，所以这里不会有陈旧的 streaming。
  const chattingFixIds = new Set<string>(
    d.select({ fixId: schema.fixTurns.fixId })
      .from(schema.fixTurns)
      .where(eq(schema.fixTurns.status, 'streaming' as any))
      .all()
      .map((r: any) => r.fixId),
  )

  // 自动化：项目级配置 + 每条 PR 的有效开关 / 运行态（喂 PR 抽屉的两个 switch + 列表「已暂停」提示）
  const autoCfg = getProjectAutomation(d, schema, id)
  const autoRowByPr = getPrAutomationMap(d, schema, id) // 一次拉全，避免 .map() 里 N+1 点查
  const autoMaxRounds = project.autoMaxRounds ?? 2
  const autoCooldownMin = project.autoCooldownMinutes ?? 5
  const nowMs = Date.now()
  const me = await getCurrentUserLogin().catch(() => null) // 自动修复作者白名单默认值（和引擎口径一致）

  return {
    pulls: page.pulls.map((p) => {
      const task = taskByPr.get(p.number)
      const fix = fixByPr.get(p.number)
      // 自动化有效开关：实例覆盖优先，否则继承项目配置 + 作者/状态过滤
      const autoRow = autoRowByPr.get(p.number) ?? null
      const prKey = { author: p.author, status: pullStatusKey(p) }
      const autoReviewOn = effectiveReviewOn(autoCfg, autoRow, prKey)
      const autoFixOn = effectiveFixOnGuarded(autoCfg, autoRow, prKey, me)
      // 作者已更新：我「看过」的 sha 之后 PR head 又变了。基线用 review.headSha——审核/复审完成都会推进它，
      // 所以点了复审看过新 commit 后红点自动清，作者在复审基线之后再 push 才重新点亮（与抽屉/refresh 口径统一）。
      // 副作用：首次审核后即便还没发评论，作者 push 也会点亮——这正是「有我没看过的新改动」的本意。
      const authorUpdated = !!task?.headSha && !!p.headSha && p.headSha !== task.headSha
      // 审核已更新：我 push 修复后 PR 的 review 计数变多 = 又有人提交了 review。
      // 注：reviewsCount 含 bot/CI 的 review，所以 push 后若有 CI 自动 review 也会算（本地单用户工具可接受）。
      const reviewerUpdated = !!fix?.pushedAt && fix.reviewsAtPush != null && p.reviewsCount > fix.reviewsAtPush
      // 本地 fix worktree 是否还在磁盘上（review worktree 用完即弃，不会残留；只有 fix 保留到 push/discard）。
      // 合并后想找残留清理就靠它。检查实际目录，不是只看 DB 字段（DB 有路径但目录可能已被手动删）。
      const hasWorktree = !!fix?.worktreePath && existsSync(fix.worktreePath)
      const fixUpdatedMs = fix?.updatedAt ? Date.parse(fix.updatedAt) : Number.NaN
      const worktreeStale = hasWorktree && (
        prKey.status === 'merged'
        || prKey.status === 'closed'
        || (Number.isFinite(fixUpdatedMs) && fixUpdatedMs < nowMs - WORKTREE_STALE_DAYS * 24 * 60 * 60 * 1000)
      )
      // 冷却中：引擎看到的 head 还是当前 head，且首见时间 + 冷却期 还没到 → 给 UI 显示「冷却中，剩 X」
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

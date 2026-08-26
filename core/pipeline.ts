import { nanoid } from 'nanoid'
import { eq } from 'drizzle-orm'
import { reviewQueue } from './queue'
import { cockpitBus } from './events'
import { prepareWorktree } from './git/worktree'
import { fetchPrMergeable } from './github/gh'
import { claudeReviewRunner } from './agent/claudeRunners'
import { codexReviewRunner } from './agent/codexReview'
import { pickByLang } from './agent/lang'
import { createRun, finishRun, recordRunUsage } from './runs/store'
import { formatUsageLabel } from './runs/format'
import type { ReviewProvider, ReviewRunner } from './agent/runners'
import { reviewAborts } from './agent/reviewAborts'
import { getAgentSettings } from './agent/settings'
import { projectDirNameFor } from './host/options'

export function selectReviewRunner(provider?: ReviewProvider): ReviewRunner {
  return provider === 'codex' ? codexReviewRunner : claudeReviewRunner
}

// The synthetic merge-conflict finding is stored in the DB, shown in the UI, and later fed back as a prompt to
// comment posting and auto-fix, so it must match this review's working language. The conflict markers
// <<<<<<< / ======= / >>>>>>> stay as-is in all three languages.
const CONFLICT_FINDING = {
  zh: {
    title: '解决与目标分支的合并冲突',
    problem: '该 PR 与目标分支存在合并冲突，当前无法干净合并。',
    fix: '把目标分支 merge/rebase 进来并解决所有冲突标记（<<<<<<< / ======= / >>>>>>>）。',
    stage: '检测到合并冲突，已加入需解决项',
  },
  en: {
    title: 'Resolve merge conflicts with the base branch',
    problem: 'This PR has merge conflicts with its base branch and cannot be merged as-is.',
    fix: 'Merge/rebase the base branch in and resolve all conflict markers (<<<<<<< / ======= / >>>>>>>).',
    stage: 'Merge conflicts detected, added as a finding',
  },
  fr: {
    title: 'Résoudre les conflits de fusion avec la branche cible',
    problem: 'Cette PR est en conflit avec sa branche cible et ne peut pas être fusionnée telle quelle.',
    fix: 'Fusionner/rebaser la branche cible puis résoudre tous les marqueurs de conflit (<<<<<<< / ======= / >>>>>>>).',
    stage: 'Conflits de fusion détectés, ajoutés comme point à traiter',
  },
}

// Don't import the db client here, so core doesn't depend on the runtime; the caller injects db + tables + config.
export type ReviewJobCtx = {
  db: any
  schema: any
  reviewId: string
  repo: string
  prNumber: number
  branch: string
  defaultBranch: string
  localPath: string | null
  methodology: string // the resolved methodology (active skill or default)
  reposDir: string
  worktreeLocation?: string | null
  provider?: ReviewProvider
  model: string // the actual model of the current provider (never mixed)
  effort: string
  codexServiceTier?: string | null
  lang?: string // working language of the AI output (UI locale); defaults to zh to preserve the old behavior
  guided?: boolean // true = targeted re-review with feedback; false/undefined = fresh first review
  // Observability: attribute the run to a project and to the exact skill version that ran (both optional for old callers).
  projectId?: string | null
  skillId?: string | null
  skillVersionId?: string | null
}

export function enqueueReview(ctx: ReviewJobCtx) {
  reviewQueue.add(() => runReviewJob(ctx))
}

export function enqueueRecheck(ctx: ReviewJobCtx) {
  reviewQueue.add(() => runRecheckJob(ctx))
}

async function runReviewJob(ctx: ReviewJobCtx) {
  const { db, schema, reviewId } = ctx
  const now = () => new Date().toISOString()

  const emit = (kind: string, message?: string) => {
    const ts = now()
    cockpitBus.emit({ reviewId, ts, kind, message })
    try {
      db.insert(schema.events).values({ id: nanoid(), reviewId, ts, kind, message: message ?? null }).run()
    } catch {
      /* failing to persist the event doesn't affect the main flow */
    }
  }
  const setStatus = (status: string, extra: Record<string, unknown> = {}) => {
    db.update(schema.reviews).set({ status, updatedAt: now(), ...extra }).where(eq(schema.reviews.id, reviewId)).run()
    cockpitBus.emit({ reviewId, ts: now(), kind: 'status', message: status })
  }
  // Consistency gate: if the task was deleted, drop the result instead of writing it back (stops a task deleted during a network hiccup from being resurrected)
  const taskGone = () => !db.select().from(schema.reviews).where(eq(schema.reviews.id, reviewId)).get()

  let wt: { path: string; headSha: string; cleanup: () => Promise<void> } | null = null
  let runId: string | null = null // the runs row for this execution (cost / tokens / model / skill version)
  const abort = new AbortController()
  reviewAborts.set(reviewId, abort)
  const hostOpts = { abort, mcpAllow: getAgentSettings(db, schema).reviewMcpAllow, projectDirName: projectDirNameFor(ctx.localPath) }
  try {
    setStatus('cloning')
    emit('stage', '准备代码（worktree）')
    wt = await prepareWorktree({
      localPath: ctx.localPath || '',
      reposDir: ctx.reposDir,
      location: ctx.worktreeLocation,
      reviewId,
      branch: ctx.branch,
      defaultBranch: ctx.defaultBranch,
      onStep: (m) => emit('stage', m),
    })

    setStatus('reviewing', { headSha: wt.headSha })

    const existing = db.select().from(schema.findings).where(eq(schema.findings.reviewId, reviewId)).all()
    const review = db.select().from(schema.reviews).where(eq(schema.reviews.id, reviewId)).get()
    const guided = ctx.guided && existing.length > 0

    // One run record per execution; the review row points at its latest run and the skill version it used.
    runId = createRun(db, schema, {
      kind: 'review', subkind: guided ? 'guided' : 'review', provider: ctx.provider === 'codex' ? 'codex' : 'claude',
      projectId: ctx.projectId ?? review?.projectId ?? null, reviewId, workspaceType: 'pr_worktree', workspacePath: wt.path,
      prNumber: ctx.prNumber, branch: ctx.branch, model: ctx.model, effort: ctx.effort, codexServiceTier: ctx.codexServiceTier,
      skillId: ctx.skillId ?? null, skillVersionId: ctx.skillVersionId ?? null, lang: ctx.lang ?? null, title: review?.title ?? null,
    })
    db.update(schema.reviews).set({ lastRunId: runId, skillVersionId: ctx.skillVersionId ?? null, updatedAt: now() }).where(eq(schema.reviews.id, reviewId)).run()

    let result: any
    let costUsd = 0
    let usage: any = null

    if (guided) {
      // ── Targeted re-review with feedback: keep notes/checkmarks, the AI responds item by item ──
      emit('stage', 'AI 针对你的反馈复审中…')
      const g = await selectReviewRunner(ctx.provider).runGuidedReview({
        cwd: wt.path, repo: ctx.repo, prNumber: ctx.prNumber, branch: ctx.branch,
        defaultBranch: ctx.defaultBranch, methodology: ctx.methodology, model: ctx.model, effort: ctx.effort, codexServiceTier: ctx.codexServiceTier, lang: ctx.lang,
        instruction: review?.reviewInstruction || '', globalNotes: review?.globalNotes || '',
        existing: existing.map((f: any) => ({ fid: f.fid, severity: f.severity, title: f.title, location: f.location, problem: f.problem, reviewerNote: f.notes })),
        onTool: (n, i) => emit('tool', `${n} ${i}`), ...hostOpts,
      })
      result = g.result
      costUsd = g.costUsd
      usage = g.usage
      recordRunUsage(db, schema, runId, usage)
      if (taskGone()) { emit('error', '任务已被删除，丢弃复审结果'); finishRun(db, schema, runId, { status: 'stopped', error: 'task deleted' }); return }

      const byFid = new Map(existing.map((f: any) => [f.fid, f]))
      const round =
        db.select().from(schema.events).where(eq(schema.events.reviewId, reviewId)).all()
          .filter((e: any) => e.kind === 'review-round').length + 1
      let maxN = existing.reduce((m: number, f: any) => Math.max(m, parseInt(String(f.fid).replace(/\D/g, '')) || 0), 0)

      for (const f of result.findings) {
        const cur = f.fid && byFid.get(f.fid)
        if (cur) {
          // update the content, keep notes/checked
          db.update(schema.findings).set({
            severity: f.severity, title: f.title, location: f.location || null,
            problem: f.problem || null, detail: f.detail || null, fix: f.fix || null, introducedByPr: f.introducedByPr,
          }).where(eq(schema.findings.id, cur.id)).run()
          if (f.response) {
            db.insert(schema.findingRechecks).values({
              id: nanoid(), findingId: cur.id, round, status: f.response.status, text: f.response.text || null, at: now(),
            }).run()
          }
          byFid.delete(f.fid)
        } else {
          // new finding
          const id = nanoid()
          db.insert(schema.findings).values({
            id, reviewId, fid: `F${++maxN}`, severity: f.severity, title: f.title, location: f.location || null,
            problem: f.problem || null, detail: f.detail || null, fix: f.fix || null, introducedByPr: f.introducedByPr,
            checked: false, notes: null, sortOrder: maxN, createdAt: now(),
          }).run()
          db.insert(schema.findingRechecks).values({
            id: nanoid(), findingId: id, round, status: 'new', text: f.response?.text || null, at: now(),
          }).run()
        }
      }
      db.insert(schema.events).values({ id: nanoid(), reviewId, ts: now(), kind: 'review-round', message: `round ${round}` }).run()
    } else {
      // ── Fresh first review: wipe and rewrite ──
      emit('stage', 'AI 审核中…')
      const reviewRunner = selectReviewRunner(ctx.provider)
      const r = await reviewRunner.runReview({
        cwd: wt.path, repo: ctx.repo, prNumber: ctx.prNumber, branch: ctx.branch,
        defaultBranch: ctx.defaultBranch, methodology: ctx.methodology, model: ctx.model, effort: ctx.effort, codexServiceTier: ctx.codexServiceTier, lang: ctx.lang,
        onTool: (name, info) => emit('tool', `${name} ${info}`), ...hostOpts,
      })
      result = r.result
      costUsd = r.costUsd
      usage = r.usage
      recordRunUsage(db, schema, runId, usage)
      if (taskGone()) { emit('error', '任务已被删除，丢弃审核结果'); finishRun(db, schema, runId, { status: 'stopped', error: 'task deleted' }); return }
      // Wipe + insert in one transaction: all or nothing, so a crash halfway doesn't leave findings empty
      db.transaction((tx: any) => {
        tx.delete(schema.findings).where(eq(schema.findings.reviewId, reviewId)).run()
        result.findings.forEach((f: any, i: number) => {
          tx.insert(schema.findings).values({
            id: nanoid(), reviewId, fid: `F${i + 1}`, severity: f.severity, title: f.title,
            location: f.location || null, problem: f.problem || null, detail: f.detail || null, fix: f.fix || null,
            introducedByPr: f.introducedByPr, checked: false, notes: null, sortOrder: i, createdAt: now(),
          }).run()
        })
      })

      // Merge conflict detection: the PR conflicts with its base branch → append a High "resolve merge conflicts" finding (auto-fix will try to resolve them).
      // A failed / UNKNOWN GitHub mergeable lookup never raises a false alarm.
      try {
        if ((await fetchPrMergeable(ctx.repo, ctx.prNumber)) === 'conflicting' && !taskGone()) {
          const c = pickByLang(ctx.lang, CONFLICT_FINDING)
          const n = result.findings.length
          db.insert(schema.findings).values({
            id: nanoid(), reviewId, fid: `F${n + 1}`, severity: 'High',
            title: c.title,
            location: null,
            problem: c.problem,
            detail: null,
            fix: c.fix,
            introducedByPr: true, checked: false, notes: null, sortOrder: n, createdAt: now(),
          }).run()
          emit('stage', c.stage)
        }
      } catch { /* a failed mergeable lookup doesn't affect the review */ }
    }

    setStatus('draft', {
      logic: result.logic || null,
      quality: result.quality || null,
      risk: result.risk || null,
      conclusion: result.conclusion || null,
      requirement: result.requirement || null,
      testPath: result.testPath || null,
    })
    finishRun(db, schema, runId, { status: 'done' })
    emit('done', `${guided ? '复审' : '审核'}完成 · ${formatUsageLabel(usage, costUsd)}`)
  } catch (e) {
    const stopped = abort.signal.aborted
    const message = stopped ? '已停止' : (e as Error).message
    if (runId) finishRun(db, schema, runId, { status: stopped ? 'stopped' : 'error', error: message })
    setStatus('error', { error: message })
    emit('error', message)
  } finally {
    reviewAborts.delete(reviewId)
    if (wt) await wt.cleanup()
  }
}

// Recheck: based on the new commits the author pushed after our comment, judge each finding fixed/partial/unaddressed and append finding_rechecks.
async function runRecheckJob(ctx: ReviewJobCtx) {
  const { db, schema, reviewId } = ctx
  const now = () => new Date().toISOString()
  const emit = (kind: string, message?: string) => {
    const ts = now()
    cockpitBus.emit({ reviewId, ts, kind, message })
    try {
      db.insert(schema.events).values({ id: nanoid(), reviewId, ts, kind, message: message ?? null }).run()
    } catch {}
  }
  const setStatus = (status: string, extra: Record<string, unknown> = {}) => {
    db.update(schema.reviews).set({ status, updatedAt: now(), ...extra }).where(eq(schema.reviews.id, reviewId)).run()
    cockpitBus.emit({ reviewId, ts: now(), kind: 'status', message: status })
  }

  const review = db.select().from(schema.reviews).where(eq(schema.reviews.id, reviewId)).get()
  const existing = db.select().from(schema.findings).where(eq(schema.findings.reviewId, reviewId)).all()
  const round =
    db.select().from(schema.events).where(eq(schema.events.reviewId, reviewId)).all()
      .filter((e: any) => e.kind === 'recheck').length + 1

  let wt: { path: string; headSha: string; cleanup: () => Promise<void> } | null = null
  let runId: string | null = null
  const abort = new AbortController()
  reviewAborts.set(reviewId, abort)
  const hostOpts = { abort, mcpAllow: getAgentSettings(db, schema).reviewMcpAllow, projectDirName: projectDirNameFor(ctx.localPath) }
  try {
    setStatus('rechecking')
    emit('stage', '复审：准备最新代码')
    wt = await prepareWorktree({
      localPath: ctx.localPath || '', reposDir: ctx.reposDir, location: ctx.worktreeLocation, reviewId,
      branch: ctx.branch, defaultBranch: ctx.defaultBranch, onStep: (m) => emit('stage', m),
    })

    runId = createRun(db, schema, {
      kind: 'review', subkind: 'recheck', provider: ctx.provider === 'codex' ? 'codex' : 'claude',
      projectId: ctx.projectId ?? review?.projectId ?? null, reviewId, workspaceType: 'pr_worktree', workspacePath: wt.path,
      prNumber: ctx.prNumber, branch: ctx.branch, model: ctx.model, effort: ctx.effort, codexServiceTier: ctx.codexServiceTier,
      skillId: ctx.skillId ?? null, skillVersionId: ctx.skillVersionId ?? null, lang: ctx.lang ?? null, title: review?.title ?? null,
    })
    // Only the run pointer: the findings were produced by an earlier (fresh/guided) review, so the review keeps that skill version.
    db.update(schema.reviews).set({ lastRunId: runId, updatedAt: now() }).where(eq(schema.reviews.id, reviewId)).run()

    emit('stage', '复审中：判断作者改了没')
    const { result, usage } = await selectReviewRunner(ctx.provider).runRecheck({
      cwd: wt.path, repo: ctx.repo, prNumber: ctx.prNumber, defaultBranch: ctx.defaultBranch,
      lastPostSha: review?.lastPostSha ?? null,
      requirement: review?.requirement ?? null,
      findings: existing.map((f: any) => ({ fid: f.fid, title: f.title, location: f.location, problem: f.problem, fix: f.fix, notes: f.notes })),
      methodology: ctx.methodology, model: ctx.model, effort: ctx.effort, codexServiceTier: ctx.codexServiceTier, lang: ctx.lang, onTool: (n, i) => emit('tool', `${n} ${i}`), ...hostOpts,
    })

    recordRunUsage(db, schema, runId, usage)
    if (!db.select().from(schema.reviews).where(eq(schema.reviews.id, reviewId)).get()) {
      emit('error', '任务已被删除，丢弃复审结果'); finishRun(db, schema, runId, { status: 'stopped', error: 'task deleted' }); return
    }
    const fidToId = new Map(existing.map((f: any) => [f.fid, f.id]))
    let applied = 0
    for (const r of result.rechecks) {
      const findingId = fidToId.get(r.fid)
      if (!findingId) continue // drop verdicts with no matching old finding (new issues go through newFindings)
      db.insert(schema.findingRechecks).values({
        id: nanoid(), findingId, round, status: r.status, text: r.text || null, at: now(),
      }).run()
      applied++
    }

    // New issues introduced by the author's new commits: create a new finding (unchecked) + attach a "new" recheck record
    let maxN = existing.reduce((m: number, f: any) => Math.max(m, parseInt(String(f.fid).replace(/\D/g, '')) || 0), 0)
    let added = 0
    for (const nf of result.newFindings ?? []) {
      const id = nanoid()
      db.insert(schema.findings).values({
        id, reviewId, fid: `F${++maxN}`, severity: nf.severity, title: nf.title, location: nf.location || null,
        problem: nf.problem || null, detail: nf.detail || null, fix: nf.fix || null,
        introducedByPr: true, checked: false, notes: null, sortOrder: maxN, createdAt: now(),
      }).run()
      db.insert(schema.findingRechecks).values({
        id: nanoid(), findingId: id, round, status: 'new', text: nf.text || null, at: now(),
      }).run()
      added++
    }

    // The post-recheck overall conclusion overwrites the AI summary; if the AI gave none (empty), keep the old summary instead of clearing it
    const newConclusion = result.conclusion?.trim()
    setStatus('draft', { headSha: wt.headSha, authorUpdated: false, ...(newConclusion ? { conclusion: newConclusion } : {}) })
    finishRun(db, schema, runId, { status: 'done' })
    emit('recheck', `复审 round ${round} 完成 · 更新 ${applied} 条${added ? ` · 新增 ${added} 条` : ''} · ${formatUsageLabel(usage, 0)}`)
  } catch (e) {
    const stopped = abort.signal.aborted
    const message = stopped ? '已停止' : (e as Error).message
    if (runId) finishRun(db, schema, runId, { status: stopped ? 'stopped' : 'error', error: message })
    setStatus('error', { error: message })
    emit('error', message)
  } finally {
    reviewAborts.delete(reviewId)
    if (wt) await wt.cleanup()
  }
}

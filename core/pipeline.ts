import { nanoid } from 'nanoid'
import { eq } from 'drizzle-orm'
import { reviewQueue } from './queue'
import { cockpitBus } from './events'
import { prepareWorktree } from './git/worktree'
import { fetchPrMergeable } from './github/gh'
import { claudeReviewRunner } from './agent/claudeRunners'
import { codexReviewRunner } from './agent/codexReview'
import { pickByLang } from './agent/lang'
import type { ReviewProvider, ReviewRunner } from './agent/runners'

export function selectReviewRunner(provider?: ReviewProvider): ReviewRunner {
  return provider === 'codex' ? codexReviewRunner : claudeReviewRunner
}

// 合并冲突那条合成 finding 会入库、在 UI 上显示、之后又被当 prompt 喂回给发评论和自动修复，
// 所以它必须跟这次审核的工作语言一致。冲突标记 <<<<<<< / ======= / >>>>>>> 三语都保持原样。
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

// 这里不直接 import db client，避免 core 依赖运行时；由调用方注入 db + 表 + 配置。
export type ReviewJobCtx = {
  db: any
  schema: any
  reviewId: string
  repo: string
  prNumber: number
  branch: string
  defaultBranch: string
  localPath: string | null
  methodology: string // 已解析的方法学（active skill 或默认）
  reposDir: string
  worktreeLocation?: string | null
  provider?: ReviewProvider
  model: string // 当前 provider 的实模型（不混用）
  effort: string
  codexServiceTier?: string | null
  lang?: string // AI 产出的工作语言（UI locale），缺省 zh 保持旧行为
  guided?: boolean // true=带反馈针对性复审；false/undefined=全新首审
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
      /* 事件落库失败不影响主流程 */
    }
  }
  const setStatus = (status: string, extra: Record<string, unknown> = {}) => {
    db.update(schema.reviews).set({ status, updatedAt: now(), ...extra }).where(eq(schema.reviews.id, reviewId)).run()
    cockpitBus.emit({ reviewId, ts: now(), kind: 'status', message: status })
  }
  // 一致性闸：task 已被删除则丢弃结果，不要回写（防止网络波动期间删了又被 resurrect）
  const taskGone = () => !db.select().from(schema.reviews).where(eq(schema.reviews.id, reviewId)).get()

  let wt: { path: string; headSha: string; cleanup: () => Promise<void> } | null = null
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

    let result: any
    let costUsd = 0

    if (guided) {
      // ── 带反馈的针对性复审：保留 notes/勾选，AI 逐条回应 ──
      emit('stage', 'AI 针对你的反馈复审中…')
      const g = await selectReviewRunner(ctx.provider).runGuidedReview({
        cwd: wt.path, repo: ctx.repo, prNumber: ctx.prNumber, branch: ctx.branch,
        defaultBranch: ctx.defaultBranch, methodology: ctx.methodology, model: ctx.model, effort: ctx.effort, codexServiceTier: ctx.codexServiceTier, lang: ctx.lang,
        instruction: review?.reviewInstruction || '', globalNotes: review?.globalNotes || '',
        existing: existing.map((f: any) => ({ fid: f.fid, severity: f.severity, title: f.title, location: f.location, problem: f.problem, reviewerNote: f.notes })),
        onTool: (n, i) => emit('tool', `${n} ${i}`),
      })
      result = g.result
      costUsd = g.costUsd
      if (taskGone()) { emit('error', '任务已被删除，丢弃复审结果'); return }

      const byFid = new Map(existing.map((f: any) => [f.fid, f]))
      const round =
        db.select().from(schema.events).where(eq(schema.events.reviewId, reviewId)).all()
          .filter((e: any) => e.kind === 'review-round').length + 1
      let maxN = existing.reduce((m: number, f: any) => Math.max(m, parseInt(String(f.fid).replace(/\D/g, '')) || 0), 0)

      for (const f of result.findings) {
        const cur = f.fid && byFid.get(f.fid)
        if (cur) {
          // 更新内容，保留 notes/checked
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
          // 新发现
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
      // ── 全新首审：清空重写 ──
      emit('stage', 'AI 审核中…')
      const reviewRunner = selectReviewRunner(ctx.provider)
      const r = await reviewRunner.runReview({
        cwd: wt.path, repo: ctx.repo, prNumber: ctx.prNumber, branch: ctx.branch,
        defaultBranch: ctx.defaultBranch, methodology: ctx.methodology, model: ctx.model, effort: ctx.effort, codexServiceTier: ctx.codexServiceTier, lang: ctx.lang,
        onTool: (name, info) => emit('tool', `${name} ${info}`),
      })
      result = r.result
      costUsd = r.costUsd
      if (taskGone()) { emit('error', '任务已被删除，丢弃审核结果'); return }
      // 清空+写入放进一个事务：要么全写要么全不写，避免崩在中间留下空 findings
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

      // 合并冲突检测：PR 与目标分支冲突 → 追加一条 High「解决合并冲突」（自动修复会尝试解冲突）。
      // GitHub mergeable 取数失败 / UNKNOWN 不误报。
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
      } catch { /* mergeable 取数失败不影响审核 */ }
    }

    setStatus('draft', {
      logic: result.logic || null,
      quality: result.quality || null,
      risk: result.risk || null,
      conclusion: result.conclusion || null,
      requirement: result.requirement || null,
      testPath: result.testPath || null,
    })
    emit('done', `${guided ? '复审' : '审核'}完成 · $${costUsd.toFixed(3)}`)
  } catch (e) {
    setStatus('error', { error: (e as Error).message })
    emit('error', (e as Error).message)
  } finally {
    if (wt) await wt.cleanup()
  }
}

// 复审：基于作者评论后的新 commit，逐条判断 fixed/partial/unaddressed，追加 finding_rechecks。
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
  try {
    setStatus('rechecking')
    emit('stage', '复审：准备最新代码')
    wt = await prepareWorktree({
      localPath: ctx.localPath || '', reposDir: ctx.reposDir, location: ctx.worktreeLocation, reviewId,
      branch: ctx.branch, defaultBranch: ctx.defaultBranch, onStep: (m) => emit('stage', m),
    })

    emit('stage', '复审中：判断作者改了没')
    const { result } = await selectReviewRunner(ctx.provider).runRecheck({
      cwd: wt.path, repo: ctx.repo, prNumber: ctx.prNumber, defaultBranch: ctx.defaultBranch,
      lastPostSha: review?.lastPostSha ?? null,
      requirement: review?.requirement ?? null,
      findings: existing.map((f: any) => ({ fid: f.fid, title: f.title, location: f.location, problem: f.problem, fix: f.fix, notes: f.notes })),
      methodology: ctx.methodology, model: ctx.model, effort: ctx.effort, codexServiceTier: ctx.codexServiceTier, lang: ctx.lang, onTool: (n, i) => emit('tool', `${n} ${i}`),
    })

    if (!db.select().from(schema.reviews).where(eq(schema.reviews.id, reviewId)).get()) {
      emit('error', '任务已被删除，丢弃复审结果'); return
    }
    const fidToId = new Map(existing.map((f: any) => [f.fid, f.id]))
    let applied = 0
    for (const r of result.rechecks) {
      const findingId = fidToId.get(r.fid)
      if (!findingId) continue // 找不到对应旧 finding 的判定丢弃（新问题走 newFindings）
      db.insert(schema.findingRechecks).values({
        id: nanoid(), findingId, round, status: r.status, text: r.text || null, at: now(),
      }).run()
      applied++
    }

    // 作者新 commit 引入的新问题：建成新 finding（未勾选）+ 挂一条「新增」复审记录
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

    // 复审后的整体结论覆盖 AI 总评；AI 没给（空）就保留原总评，不清空
    const newConclusion = result.conclusion?.trim()
    setStatus('draft', { headSha: wt.headSha, authorUpdated: false, ...(newConclusion ? { conclusion: newConclusion } : {}) })
    emit('recheck', `复审 round ${round} 完成 · 更新 ${applied} 条${added ? ` · 新增 ${added} 条` : ''}`)
  } catch (e) {
    setStatus('error', { error: (e as Error).message })
    emit('error', (e as Error).message)
  } finally {
    if (wt) await wt.cleanup()
  }
}

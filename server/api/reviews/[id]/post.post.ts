import { nanoid } from 'nanoid'
import { createHash } from 'node:crypto'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { schema } from '~core/db/client'
import { assembleReview, postReview, type PostFinding } from '~core/github/post'
import { fetchPrDiff } from '~core/github/gh'

// 发布评论。dryRun=true 只返回组装预览（默认），dryRun=false 才真正发到 GitHub。
// 预览结果按"输入签名"缓存：签名没变就直接复用，不重新翻译；发布也复用预览，避免再跑一次。
const Body = z.object({
  dryRun: z.boolean().default(true).catch(true),
  force: z.boolean().default(false).catch(false),
})

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const { dryRun, force } = Body.parse((await readBody(event)) || {})
  const d = db()

  const review = d.select().from(schema.reviews).where(eq(schema.reviews.id, id)).get()
  if (!review) throw createError({ statusCode: 404, statusMessage: 'review 不存在' })
  // 任务在跑（克隆/审核/复审）或正在发布（posting）时不能发布/预览，防和正在写 findings 的 job 抢同一批数据。
  // 允许 draft / ready_to_post / posted（再发）/ error。
  if (['queued', 'cloning', 'reviewing', 'recheck_requested', 'rechecking', 'posting'].includes(review.status)) {
    throw createError({ statusCode: 409, statusMessage: `当前状态（${review.status}）不能发布评论，请等任务完成` })
  }
  const project = d.select().from(schema.projects).where(eq(schema.projects.id, review.projectId)).get()
  if (!project) throw createError({ statusCode: 404, statusMessage: '项目不存在' })

  // 真发（非预览）：在任何 await 之前**原子认领**——把行从可发状态一步 CAS 到 'posting'，占住整个
  // 组装(翻译)+发布窗口（数秒）。better-sqlite3 同步执行，认领早于所有 await → 两个并发发布者只有一个
  // changes===1 能拿到；'posting' 已进 run/recheck/引擎/本端点的 in-flight 判断 → 期间的重跑/复查/再发都被挡。
  // 杜绝「发两条 / 发已被删的旧 findings / 状态被并发写覆盖」。预览(dryRun)不认领。
  const prevStatus = review.status
  if (!dryRun) {
    const claimed = d.update(schema.reviews)
      .set({ status: 'posting', updatedAt: new Date().toISOString() })
      .where(and(eq(schema.reviews.id, id), inArray(schema.reviews.status, ['draft', 'ready_to_post', 'posted', 'error'])))
      .run()
    if (claimed.changes !== 1) throw createError({ statusCode: 409, statusMessage: '评论正在发布中或状态已变化，请稍后再试' })
  }
  // 认领后中途任何失败 / 无内容 → 恢复到认领前状态，别把行永久卡在 'posting'。
  const restore = () => {
    if (dryRun) return
    d.update(schema.reviews).set({ status: prevStatus, updatedAt: new Date().toISOString() })
      .where(and(eq(schema.reviews.id, id), eq(schema.reviews.status, 'posting'))).run()
  }

  try {
    const checked = d
      .select()
      .from(schema.findings)
      .where(and(eq(schema.findings.reviewId, id), eq(schema.findings.checked, true)))
      .orderBy(asc(schema.findings.sortOrder))
      .all()
    if (!checked.length) {
      throw createError({ statusCode: 400, statusMessage: '没有勾选任何 finding，不发空评论' })
    }

    // 每条勾选 finding 的最新一轮复审结论（决定怎么发：已修复→summary一行 / 部分→只说还差什么 / 仅回复→按 note 再回应或跳过）
    const checkedIds = checked.map((f) => f.id)
    const rcs = d.select().from(schema.findingRechecks).where(inArray(schema.findingRechecks.findingId, checkedIds)).all()
    const latestRc = new Map<string, { status: string; text: string | null; round: number }>()
    for (const rc of rcs) {
      const cur = latestRc.get(rc.findingId)
      if (!cur || rc.round > cur.round) latestRc.set(rc.findingId, { status: rc.status, text: rc.text, round: rc.round })
    }

    const findings: PostFinding[] = checked.map((f) => {
      const rc = latestRc.get(f.id)
      return {
        fid: f.fid, severity: f.severity as any, title: f.title, location: f.location,
        problem: f.problem, detail: f.detail, fix: f.fix, notes: f.notes, introducedByPr: f.introducedByPr,
        recheck: rc ? { status: rc.status, text: rc.text } : null,
      }
    })

    // 输入签名：勾选的 finding 内容 + 复审结论 + 整体注释 + headSha（影响行级映射）。变了才重新生成。
    const rc = resolveReviewConfig(d, project)
    const sig = createHash('sha256')
      .update(JSON.stringify({
        gn: review.globalNotes || '',
        sha: review.headSha || '',
        provider: rc.provider,
        model: rc.translateModel,
        codexServiceTier: rc.codexServiceTier || '',
        f: findings.map((f) => [f.fid, f.severity, f.title, f.problem, f.detail, f.fix, f.notes, f.location, f.introducedByPr, f.recheck?.status || '', f.recheck?.text || '']),
      }))
      .digest('hex')

    let assembled: any
    const usedCache = !force && review.previewSig === sig && !!review.previewJson
    if (usedCache) {
      assembled = JSON.parse(review.previewJson!) // 命中缓存，不重新翻译
    } else {
      const { diff } = await fetchPrDiff(project.repo, review.prNumber)
      // 翻译跟随项目 provider（不混用）：claude 用快模型 TRANSLATE_MODEL；codex 用 codex 主模型。
      assembled = await assembleReview({
        provider: rc.provider,
        model: rc.translateModel,
        codexServiceTier: rc.codexServiceTier,
        cwd: project.localPath || undefined,
        findings,
        globalNotes: review.globalNotes || '',
        diff,
      })
      d.update(schema.reviews)
        .set({ previewJson: JSON.stringify(assembled), previewSig: sig, updatedAt: new Date().toISOString() })
        .where(eq(schema.reviews.id, id))
        .run()
    }

    if (dryRun) return { dryRun: true, assembled, cached: usedCache }

    // 勾选项全被复审状态过滤掉（仅回复无回应 / 已撤回）→ 没内容可发，别发空 review
    if (!assembled.comments.length && !String(assembled.body || '').trim()) {
      throw createError({ statusCode: 400, statusMessage: '勾选的 finding 都按复审状态跳过了（仅回复未写回应 note / 已撤回），没有可发内容' })
    }

    const headSha = review.headSha || ''
    const { url } = await postReview({ repo: project.repo, prNumber: review.prNumber, headSha, assembled })

    const now = new Date().toISOString()
    const round = d.select().from(schema.posts).where(eq(schema.posts.reviewId, id)).all().length + 1
    d.insert(schema.posts).values({
      id: nanoid(), reviewId: id, round, url, sha: headSha, mode: assembled.mode, body: assembled.body, at: now,
    }).run()
    // 认领的 'posting' → 'posted'（收尾）。因为整个窗口都占着 'posting'，这里直接落定即可。
    d.update(schema.reviews)
      .set({ status: 'posted', lastPostSha: headSha, lastPostUrl: url, authorUpdated: false, updatedAt: now })
      .where(eq(schema.reviews.id, id))
      .run()
    d.insert(schema.events).values({ id: nanoid(), reviewId: id, ts: now, kind: 'posted', message: url }).run()

    return { dryRun: false, url, mode: assembled.mode }
  } catch (e) {
    restore()
    throw e
  }
})

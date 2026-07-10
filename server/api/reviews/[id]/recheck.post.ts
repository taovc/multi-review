import { eq } from 'drizzle-orm'
import { schema } from '~core/db/client'
import { enqueueRecheck } from '~core/pipeline'
import { reviewQueue } from '~core/queue'
import { fetchPrMeta } from '~core/github/gh'

// 触发复审（作者在评论后又 push 了，想让 AI 再看一遍改了没）
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const cfg = useRuntimeConfig()
  const d = db()

  const review = d.select().from(schema.reviews).where(eq(schema.reviews.id, id)).get()
  if (!review) throw createError({ statusCode: 404, statusMessage: 'review 不存在' })
  if (['queued', 'cloning', 'reviewing', 'recheck_requested', 'rechecking', 'posting'].includes(review.status)) {
    throw createError({ statusCode: 409, statusMessage: '该任务正在处理中，请等它完成再操作' })
  }
  const project = d.select().from(schema.projects).where(eq(schema.projects.id, review.projectId)).get()
  if (!project) throw createError({ statusCode: 404, statusMessage: '项目不存在' })
  if (!project.localPath) throw createError({ statusCode: 400, statusMessage: '项目未配置本地 clone 路径' })

  // Tâche sans branche (créée via le drawer) → résoudre via GitHub et persister avant de relancer.
  let branch = review.branch
  if (!branch) {
    try {
      branch = (await fetchPrMeta(project.repo, review.prNumber)).branch
    } catch (e) {
      throw createError({ statusCode: 502, statusMessage: (e as Error).message })
    }
    if (!branch) throw createError({ statusCode: 400, statusMessage: '无法获取 PR 分支（可能已删除）' })
    d.update(schema.reviews).set({ branch, updatedAt: new Date().toISOString() }).where(eq(schema.reviews.id, id)).run()
  }

  reviewQueue.setLimit(Number(cfg.maxConcurrency) || 3)
  // 重入复审时清掉上一轮的 error（可能是从 error 状态重新发起）
  d.update(schema.reviews).set({ status: 'recheck_requested', error: null, updatedAt: new Date().toISOString() }).where(eq(schema.reviews.id, id)).run()

  const rc = resolveReviewConfig(d, project)
  enqueueRecheck({
    db: d, schema, reviewId: id,
    repo: project.repo, prNumber: review.prNumber, branch,
    defaultBranch: project.defaultBranch, localPath: project.localPath,
    methodology: rc.methodology,
    reposDir: cfg.reposDir as string, provider: rc.provider, model: rc.model, effort: rc.effort, codexServiceTier: rc.codexServiceTier, lang: getCookie(event, 'mr-locale') || 'zh',
  })
  return { ok: true, status: 'recheck_requested' }
})

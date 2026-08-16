import { eq } from 'drizzle-orm'
import { schema } from '~core/db/client'
import { enqueueReview } from '~core/pipeline'
import { reviewQueue } from '~core/queue'
import { fetchPrMeta } from '~core/github/gh'

// Trigger (or re-run) a review task: set it to queued and enqueue it.
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const cfg = useRuntimeConfig()
  const d = db()
  // fresh=true → full review from scratch (wipes the findings, NON-guided review).
  // Default → guided re-review that keeps findings + notes ("re-check against my feedback").
  const body = (await readBody(event).catch(() => ({}))) as { fresh?: boolean }
  const fresh = body?.fresh === true

  const review = d.select().from(schema.reviews).where(eq(schema.reviews.id, id)).get()
  if (!review) throw createError({ statusCode: 404, statusMessage: 'review 不存在' })
  // Already being processed → don't trigger again
  if (['queued', 'cloning', 'reviewing', 'recheck_requested', 'rechecking', 'posting'].includes(review.status)) {
    throw createError({ statusCode: 409, statusMessage: '该任务正在处理中，请等它完成再操作' })
  }

  const project = d.select().from(schema.projects).where(eq(schema.projects.id, review.projectId)).get()
  if (!project) throw createError({ statusCode: 404, statusMessage: '项目不存在' })
  if (!project.localPath) {
    throw createError({ statusCode: 400, statusMessage: '项目未配置本地 clone 路径（worktree 需要它）' })
  }

  // Older tasks created without a branch (e.g. via the "PR detail" drawer) → resolve it through
  // GitHub and persist it, so a re-run works without having to recreate the task.
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
  d.update(schema.reviews).set({ status: 'queued', error: null, updatedAt: new Date().toISOString() }).where(eq(schema.reviews.id, id)).run()

  const rc = resolveReviewConfig(d, project)
  enqueueReview({
    db: d,
    schema,
    reviewId: id,
    repo: project.repo,
    prNumber: review.prNumber,
    branch,
    defaultBranch: project.defaultBranch,
    localPath: project.localPath,
    methodology: rc.methodology,
    reposDir: cfg.reposDir as string,
    worktreeLocation: cfg.worktreeLocation as string,
    provider: rc.provider,
    model: rc.model,
    effort: rc.effort,
    codexServiceTier: rc.codexServiceTier,
    lang: getCookie(event, 'mr-locale') || 'zh',
    guided: !fresh,
  })

  return { ok: true, status: 'queued' }
})

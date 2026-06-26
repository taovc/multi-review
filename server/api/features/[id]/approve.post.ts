import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { schema } from '~core/db/client'
import { runFeatureImplJob, isFeatureBusy, buildImplementMessage, type FeatureImplJobCtx } from '~core/feature/pipeline'
import { PlanSchema } from '~core/agent/featurePlan'

// 批准方案 + 答复决策点 → 进入阶段2：建新分支 worktree 并实现（acceptEdits，不自动 commit）。
const Body = z.object({ decisions: z.record(z.string(), z.string()).default({}) })

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const { decisions } = Body.parse((await readBody(event).catch(() => ({}))) || {})
  const cfg = useRuntimeConfig()
  const d = db()
  const task = d.select().from(schema.featureTasks).where(eq(schema.featureTasks.id, id)).get()
  if (!task) throw createError({ statusCode: 404, statusMessage: 'feature 任务不存在' })
  if (isFeatureBusy(id)) throw createError({ statusCode: 409, statusMessage: '正在处理中，请等它完成' })
  if (!task.planJson) throw createError({ statusCode: 400, statusMessage: '还没有方案可批准' })
  if (!['planned', 'built', 'error'].includes(task.status)) throw createError({ statusCode: 409, statusMessage: `当前状态（${task.status}）不能批准实现` })
  const project = d.select().from(schema.projects).where(eq(schema.projects.id, task.projectId)).get()
  if (!project?.localPath) throw createError({ statusCode: 400, statusMessage: '项目未配置本地 clone 路径' })

  let plan
  try { plan = PlanSchema.parse(JSON.parse(task.planJson)) } catch { throw createError({ statusCode: 400, statusMessage: '方案数据损坏，请重新分析' }) }

  const rc = resolveReviewConfig(d, project)
  d.update(schema.featureTasks).set({ decisions: JSON.stringify(decisions), updatedAt: new Date().toISOString() }).where(eq(schema.featureTasks.id, id)).run()

  const ctx: FeatureImplJobCtx = {
    db: d, schema, taskId: id,
    localPath: project.localPath, reposDir: cfg.reposDir as string,
    provider: rc.provider, model: rc.model, effort: rc.effort,
    defaultBranch: project.defaultBranch, lang: task.lang || 'zh',
  }
  void runFeatureImplJob(ctx, buildImplementMessage(plan, decisions, task.lang || 'zh')).catch((e) => console.error('[feature-impl] job failed', e))
  return { ok: true }
})

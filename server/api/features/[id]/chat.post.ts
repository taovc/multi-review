import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { schema } from '~core/db/client'
import { runFeaturePlanJob, runFeatureImplJob, isFeatureBusy, type FeaturePlanJobCtx, type FeatureImplJobCtx } from '~core/feature/pipeline'

// 按阶段路由：analyzing/planned → 阶段1 重新出方案（细化/答复）; building/built → 阶段2 继续实现。
const Body = z.object({ message: z.string().min(1).max(20000) })

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const { message } = Body.parse((await readBody(event)) || {})
  const cfg = useRuntimeConfig()
  const d = db()
  const task = d.select().from(schema.featureTasks).where(eq(schema.featureTasks.id, id)).get()
  if (!task) throw createError({ statusCode: 404, statusMessage: 'feature 任务不存在' })
  if (isFeatureBusy(id)) throw createError({ statusCode: 409, statusMessage: '正在处理中，请等它完成' })
  const project = d.select().from(schema.projects).where(eq(schema.projects.id, task.projectId)).get()
  if (!project?.localPath) throw createError({ statusCode: 400, statusMessage: '项目未配置本地 clone 路径' })
  const rc = resolveReviewConfig(d, project)

  // 已进入实现阶段(有 worktree / 状态 building·built)就继续实现；否则(含未建 worktree 的 error)走重新出方案。
  // 用 worktreePath 兜底：phase-2 崩溃自愈成 error 后，仍应继续实现而不是丢掉 worktree 重新 plan。
  const inImplPhase = task.status === 'building' || task.status === 'built' || !!task.worktreePath
  if (inImplPhase) {
    // 阶段2：在新分支 worktree 里继续实现
    const ctx: FeatureImplJobCtx = {
      db: d, schema, taskId: id,
      localPath: project.localPath, reposDir: cfg.reposDir as string,
      provider: rc.provider, model: rc.model, effort: rc.effort,
      defaultBranch: project.defaultBranch, lang: task.lang || 'zh',
    }
    void runFeatureImplJob(ctx, message).catch((e) => console.error('[feature-impl] job failed', e))
  } else {
    // 阶段1：重新出方案（用内置功能方法学，不用项目审核方法学）
    const ctx: FeaturePlanJobCtx = {
      db: d, schema, taskId: id, cwd: project.localPath,
      provider: rc.provider, model: rc.model, effort: rc.effort, lang: task.lang || 'zh', methodology: null,
    }
    void runFeaturePlanJob(ctx, message).catch((e) => console.error('[feature-plan] job failed', e))
  }
  return { ok: true }
})

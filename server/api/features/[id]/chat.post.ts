import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { schema } from '~core/db/client'
import { runFeaturePlanJob, isFeatureBusy, type FeaturePlanJobCtx } from '~core/feature/pipeline'

// 阶段1 细化：对上一版方案提反馈 / 答复决策点 → 重新出方案。（阶段2 实现走 PR-D。）
const Body = z.object({ message: z.string().min(1).max(20000) })

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const { message } = Body.parse((await readBody(event)) || {})
  const d = db()
  const task = d.select().from(schema.featureTasks).where(eq(schema.featureTasks.id, id)).get()
  if (!task) throw createError({ statusCode: 404, statusMessage: 'feature 任务不存在' })
  if (isFeatureBusy(id)) throw createError({ statusCode: 409, statusMessage: '正在分析中，请等它完成' })
  const project = d.select().from(schema.projects).where(eq(schema.projects.id, task.projectId)).get()
  if (!project?.localPath) throw createError({ statusCode: 400, statusMessage: '项目未配置本地 clone 路径' })

  const rc = resolveReviewConfig(d, project)
  const ctx: FeaturePlanJobCtx = {
    db: d, schema, taskId: id, cwd: project.localPath,
    provider: rc.provider, model: rc.model, effort: rc.effort, lang: task.lang || 'zh', methodology: null,
  }
  void runFeaturePlanJob(ctx, message).catch((e) => console.error('[feature-plan] job failed', e))
  return { ok: true }
})

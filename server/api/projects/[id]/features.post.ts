import { nanoid } from 'nanoid'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { schema } from '~core/db/client'
import { runFeaturePlanJob, type FeaturePlanJobCtx } from '~core/feature/pipeline'

// 新建 feature 任务 + 立即跑阶段1(只读分析出方案)。description = 需求原文 / 贴进来的 issue。
const Body = z.object({ description: z.string().min(1).max(20000) })

export default defineEventHandler(async (event) => {
  const projectId = getRouterParam(event, 'id')!
  const { description } = Body.parse((await readBody(event)) || {})
  const d = db()
  const project = d.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()
  if (!project) throw createError({ statusCode: 404, statusMessage: '项目不存在' })
  if (!project.localPath) throw createError({ statusCode: 400, statusMessage: '项目未配置本地 clone 路径（分析需要读代码）' })

  const rc = resolveReviewConfig(d, project)
  const lang = getCookie(event, 'mr-locale') || 'zh'
  const now = new Date().toISOString()
  const id = nanoid()
  d.insert(schema.featureTasks)
    .values({
      id,
      projectId,
      title: null,
      description,
      provider: rc.provider,
      model: rc.model || null,
      lang,
      status: 'analyzing',
      planJson: null,
      decisions: null,
      baseBranch: project.defaultBranch,
      branch: null,
      worktreePath: null,
      baseHeadSha: null,
      prNumber: null,
      prUrl: null,
      sessionId: null,
      codexSessionId: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    })
    .run()

  // 用内置功能开发方法学(methodology: null)，不要用项目的「审核」方法学。
  const ctx: FeaturePlanJobCtx = {
    db: d, schema, taskId: id, cwd: project.localPath,
    provider: rc.provider, model: rc.model, effort: rc.effort, lang, methodology: null,
  }
  void runFeaturePlanJob(ctx, description).catch((e) => console.error('[feature-plan] job failed', e))
  return { id }
})

import { nanoid } from 'nanoid'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { dirname, resolve } from 'node:path'
import { schema } from '~core/db/client'
import { runFeatureDevelopJob, type FeatureDevelopJobCtx } from '~core/feature/pipeline'

// 新建 feature 任务并立即开跑（单段式：agent 直接在隔离 worktree 里开发）。
// description = 抽屉里的首条消息 / 需求原文（可含 issue 链接）。
const Body = z.object({
  description: z.string().min(1).max(20000),
  allowDanger: z.boolean().optional(),
  ultracode: z.boolean().optional(),
})

export default defineEventHandler(async (event) => {
  const projectId = getRouterParam(event, 'id')!
  const { description, allowDanger, ultracode } = Body.parse((await readBody(event)) || {})
  const d = db()
  const project = d.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()
  if (!project) throw createError({ statusCode: 404, statusMessage: '项目不存在' })
  if (!project.localPath) throw createError({ statusCode: 400, statusMessage: '项目未配置本地 clone 路径（开发需要读代码）' })

  const rc = resolveReviewConfig(d, project)
  const cfg = useRuntimeConfig()
  // issue/PR 配图落到 data 目录下（dbPath 同级），绝对路径，agent 的 Read 工具才找得到。
  const assetsDir = resolve(process.cwd(), dirname(cfg.dbPath as string), 'issue-assets')
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
      status: 'working',
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

  const ctx: FeatureDevelopJobCtx = {
    db: d, schema, taskId: id,
    localPath: project.localPath, reposDir: cfg.reposDir as string, defaultBranch: project.defaultBranch, repo: project.repo,
    provider: rc.provider, model: rc.model, translateModel: rc.translateModel, effort: rc.effort, codexServiceTier: rc.codexServiceTier, lang,
    allowDanger: !!allowDanger, ultracode: !!ultracode, assetsDir,
  }
  void runFeatureDevelopJob(ctx, description).catch((e) => console.error('[feature-develop] job failed', e))
  return { id }
})

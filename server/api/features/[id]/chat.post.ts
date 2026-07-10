import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { dirname, resolve } from 'node:path'
import { schema } from '~core/db/client'
import { runFeatureDevelopJob, isFeatureBusy, type FeatureDevelopJobCtx } from '~core/feature/pipeline'

// 单段式开发对话：在隔离 worktree 里 bypassPermissions 全权限开发。
// allowDanger 放行危险命令（含 git push / gh pr create —— 「开 PR」按钮会带上 true）。
// ultracode = 后台激活；存库仍是干净消息，具体执行方式交给 provider runner。
const Body = z.object({
  message: z.string().min(1).max(20000),
  allowDanger: z.boolean().default(false),
  ultracode: z.boolean().default(false),
})

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const { message, allowDanger, ultracode } = Body.parse((await readBody(event)) || {})
  const cfg = useRuntimeConfig()
  const d = db()
  const task = d.select().from(schema.featureTasks).where(eq(schema.featureTasks.id, id)).get()
  if (!task) throw createError({ statusCode: 404, statusMessage: 'feature 任务不存在' })
  if (isFeatureBusy(id)) throw createError({ statusCode: 409, statusMessage: '正在处理中，请等它完成' })
  const project = d.select().from(schema.projects).where(eq(schema.projects.id, task.projectId)).get()
  if (!project?.localPath) throw createError({ statusCode: 400, statusMessage: '项目未配置本地 clone 路径' })
  const rc = resolveReviewConfig(d, project)
  const assetsDir = resolve(process.cwd(), dirname(cfg.dbPath as string), 'issue-assets')

  const ctx: FeatureDevelopJobCtx = {
    db: d, schema, taskId: id,
    localPath: project.localPath, reposDir: cfg.reposDir as string, defaultBranch: project.defaultBranch, repo: project.repo,
    provider: rc.provider, model: rc.model, translateModel: rc.translateModel, effort: rc.effort, codexServiceTier: rc.codexServiceTier, lang: task.lang || 'zh',
    allowDanger, ultracode, assetsDir,
  }
  void runFeatureDevelopJob(ctx, message).catch((e) => console.error('[feature-develop] job failed', e))
  return { ok: true }
})

import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { dirname, resolve } from 'node:path'
import { schema } from '~core/db/client'
import { runFeatureDevelopJob, isFeatureBusy, type FeatureDevelopJobCtx } from '~core/feature/pipeline'
import { resolveLang } from '~core/agent/lang'

// Single-phase development conversation: full-permission development in an isolated worktree via
// bypassPermissions.
// allowDanger lets dangerous commands through (including git push / gh pr create — the "open PR" button
// sends true).
// ultracode = activated behind the scenes; the stored message stays clean, and how it is executed is left
// to the provider runner.
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
    localPath: project.localPath, reposDir: cfg.reposDir as string, worktreeLocation: cfg.worktreeLocation as string, defaultBranch: project.defaultBranch, repo: project.repo,
    provider: rc.provider, model: rc.model, translateModel: rc.translateModel, effort: rc.effort, codexServiceTier: rc.codexServiceTier, lang: resolveLang(task.lang),
    allowDanger, ultracode, assetsDir,
  }
  void runFeatureDevelopJob(ctx, message).catch((e) => console.error('[feature-develop] job failed', e))
  return { ok: true }
})

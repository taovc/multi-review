import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { dirname, resolve } from 'node:path'
import { schema } from '~core/db/client'
import { runFixChatJob, isChatting, type FixJobCtx } from '~core/fix/pipeline'
import { resolveLang } from '~core/agent/lang'

// Chat workspace: once a fix task exists you can chat with it and let the AI edit code right away,
// without first running a batch fix pass. A single session can carry the follow-up polishing.
// Allowed in open/ready/error/pushed; only one chat at a time per fix.
const Body = z.object({ message: z.string().min(1).max(8000), allowDanger: z.boolean().optional(), ultracode: z.boolean().optional(), permissionMode: z.enum(['default', 'acceptEdits', 'plan', 'bypassPermissions']).optional() })

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const { message, allowDanger, ultracode, permissionMode } = Body.parse((await readBody(event)) || {})
  const cfg = useRuntimeConfig()
  const d = db()

  const fix = d.select().from(schema.fixes).where(eq(schema.fixes.id, id)).get()
  if (!fix) throw createError({ statusCode: 404, statusMessage: 'fix 不存在' })
  if (!['open', 'ready', 'pushed', 'error'].includes(fix.status)) {
    throw createError({ statusCode: 409, statusMessage: `当前状态（${fix.status}）不能对话` })
  }
  if (isChatting(id)) throw createError({ statusCode: 409, statusMessage: '上一条还在生成中，请等它完成或停止' })

  const project = d.select().from(schema.projects).where(eq(schema.projects.id, fix.projectId)).get()
  if (!project?.localPath) throw createError({ statusCode: 400, statusMessage: '项目未配置本地 clone 路径' })

  const rc = resolveReviewConfig(d, project)
  const ctx: FixJobCtx = {
    db: d, schema,
    fixId: id,
    repo: project.repo,
    prNumber: fix.prNumber,
    branch: fix.branch,
    defaultBranch: project.defaultBranch,
    localPath: project.localPath,
    reposDir: cfg.reposDir as string,
    worktreeLocation: cfg.worktreeLocation as string,
    provider: rc.provider,
    model: rc.model,
    effort: rc.effort,
    codexServiceTier: rc.codexServiceTier,
    lang: resolveLang(fix.lang),
    allowDanger: !!allowDanger,
    ultracode: !!ultracode,
    permissionMode,
    assetsDir: resolve(process.cwd(), dirname(cfg.dbPath as string), 'issue-assets'),
  }
  // fire-and-forget: long-running job, progress goes over SSE; errors are already caught and persisted inside the job.
  // The extra log here is a backstop so a throw in the job's own teardown isn't silently swallowed.
  void runFixChatJob(ctx, message).catch((e) => console.error('[fix-chat] job failed', e))
  return { ok: true }
})

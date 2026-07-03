import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { dirname, resolve } from 'node:path'
import { schema } from '~core/db/client'
import { runFixChatJob, isChatting, type FixJobCtx } from '~core/fix/pipeline'

// 对话工作区：fix task 创建后就能直接聊、直接让 AI 改代码，不必先跑一轮批量修复。
// 一个会话就能干完后续精修。open/ready/error/pushed 可发；同一 fix 同时只允许一个 chat。
const Body = z.object({ message: z.string().min(1).max(8000), allowDanger: z.boolean().optional(), ultracode: z.boolean().optional() })

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const { message, allowDanger, ultracode } = Body.parse((await readBody(event)) || {})
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
    provider: rc.provider,
    model: rc.model,
    effort: rc.effort,
    codexServiceTier: rc.codexServiceTier,
    lang: fix.lang || 'zh',
    allowDanger: !!allowDanger,
    ultracode: !!ultracode,
    assetsDir: resolve(process.cwd(), dirname(cfg.dbPath as string), 'issue-assets'),
  }
  // fire-and-forget：长任务，进度走 SSE；错误已在 job 内部捕获落库。
  // 这里再兜底 log，避免 job 收尾自身抛错被静默吞掉。
  void runFixChatJob(ctx, message).catch((e) => console.error('[fix-chat] job failed', e))
  return { ok: true }
})

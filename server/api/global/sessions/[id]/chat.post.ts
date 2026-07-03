import { eq } from 'drizzle-orm'
import { z } from 'zod'
import os from 'node:os'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { schema } from '~core/db/client'
import { runGlobalChatJob, isGlobalChatting, type GlobalChatJobCtx } from '~core/global/pipeline'
import type { ReviewProvider } from '~core/agent/runners'

// 发一条全局会话消息（fire-and-forget，进度走 SSE）。可带 cwd（/cd）：校验存在后持久化到 session。
const Body = z.object({ message: z.string().min(1).max(20000), cwd: z.string().optional(), allowDanger: z.boolean().optional(), ultracode: z.boolean().optional() })

function defaultGlobalProvider(cfg: ReturnType<typeof useRuntimeConfig>): ReviewProvider {
  return cfg.inferenceProvider === 'codex' ? 'codex' : 'claude'
}

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const { message, cwd, allowDanger, ultracode } = Body.parse((await readBody(event)) || {})
  const d = db()
  const session = d.select().from(schema.globalSessions).where(eq(schema.globalSessions.id, id)).get()
  if (!session) throw createError({ statusCode: 404, statusMessage: 'session 不存在' })
  if (isGlobalChatting(id)) throw createError({ statusCode: 409, statusMessage: '上一条还在生成中，请等它完成或停止' })

  // 工作目录：session.cwd → 否则用户主目录。传了 cwd（/cd）就校验并更新。
  let workdir = session.cwd || os.homedir()
  if (cwd && cwd.trim()) {
    workdir = cwd.trim()
    if (!existsSync(workdir)) throw createError({ statusCode: 400, statusMessage: `目录不存在: ${workdir}` })
    d.update(schema.globalSessions).set({ cwd: workdir }).where(eq(schema.globalSessions.id, id)).run()
  }

  // 助手项目无关：model/effort 优先用会话自带的，没有就回退到当前 provider 的中心默认配置。
  const cfg = useRuntimeConfig()
  const configuredProvider = defaultGlobalProvider(cfg)
  const hasNativeSession = !!session.sessionId || !!session.codexSessionId
  const provider = hasNativeSession ? (session.provider === 'codex' ? 'codex' : 'claude') : configuredProvider
  if (!hasNativeSession && session.provider !== provider) {
    d.update(schema.globalSessions).set({ provider, model: null }).where(eq(schema.globalSessions.id, id)).run()
  }
  const ctx: GlobalChatJobCtx = {
    db: d, schema, sessionId: id, cwd: workdir,
    provider,
    // 不混用：codex 会话兜底用 codex 模型（空=Codex 默认），别把 claude 模型塞进 codex。
    model: session.model || (provider === 'codex' ? (cfg.codexModel as string) : (cfg.anthropicModel as string)) || '',
    effort: session.effort || (cfg.globalEffort as string) || undefined,
    lang: getCookie(event, 'mr-locale') || 'zh',
    allowDanger: !!allowDanger,
    ultracode: !!ultracode,
    assetsDir: resolve(process.cwd(), dirname(cfg.dbPath as string), 'issue-assets'),
  }
  void runGlobalChatJob(ctx, message).catch((e) => console.error('[global-chat] job failed', e))
  return { ok: true, cwd: workdir }
})

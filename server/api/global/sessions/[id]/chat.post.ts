import { eq } from 'drizzle-orm'
import { z } from 'zod'
import os from 'node:os'
import { existsSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { schema } from '~core/db/client'
import { runGlobalChatJob, isGlobalChatting, type GlobalChatJobCtx } from '~core/global/pipeline'
import type { ReviewProvider } from '~core/agent/runners'
import { resolveGlobalAgentDefaults, runtimeGlobalAgentDefaults } from '../../../../utils/globalAgentConfig'

// 发一条全局会话消息（fire-and-forget，进度走 SSE）。可带 cwd（/cd）：校验存在后持久化到 session。
const Body = z.object({ message: z.string().min(1).max(20000), cwd: z.string().optional(), allowDanger: z.boolean().optional(), ultracode: z.boolean().optional(), projectId: z.string().optional() })

function existingPath(path?: string | null): string | null {
  const p = path?.trim()
  if (!p) return null
  try {
    return statSync(p).isDirectory() ? p : null
  } catch {
    return null
  }
}

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const { message, cwd, allowDanger, ultracode, projectId } = Body.parse((await readBody(event)) || {})
  const d = db()
  const session = d.select().from(schema.globalSessions).where(eq(schema.globalSessions.id, id)).get()
  if (!session) throw createError({ statusCode: 404, statusMessage: 'session 不存在' })
  if (isGlobalChatting(id)) throw createError({ statusCode: 409, statusMessage: '上一条还在生成中，请等它完成或停止' })

  const cfg = useRuntimeConfig()
  const defaults = resolveGlobalAgentDefaults(d, cfg, projectId)

  // 工作目录：session.cwd → 项目 localPath → 用户主目录。传了 cwd（/cd）就校验并更新。
  const defaultCwd = existingPath(defaults.cwd)
  let workdir = existingPath(session.cwd) || defaultCwd || os.homedir()
  if (cwd && cwd.trim()) {
    workdir = cwd.trim()
    if (!existsSync(workdir)) throw createError({ statusCode: 400, statusMessage: `目录不存在: ${workdir}` })
    d.update(schema.globalSessions).set({ cwd: workdir }).where(eq(schema.globalSessions.id, id)).run()
  } else if ((session.cwd && session.cwd !== workdir) || (!session.cwd && defaultCwd)) {
    d.update(schema.globalSessions).set({ cwd: workdir }).where(eq(schema.globalSessions.id, id)).run()
  }

  // 没有原生 Claude/Codex session 前，允许当前项目配置决定全局助手走哪个 provider。
  // 一旦已有原生 session，就固定原 provider，避免拿 Claude session 去 resume Codex 或反过来。
  const hasNativeSession = !!session.sessionId || !!session.codexSessionId
  const provider: ReviewProvider = hasNativeSession ? (session.provider === 'codex' ? 'codex' : 'claude') : defaults.provider
  const providerDefaults = provider === defaults.provider ? defaults : runtimeGlobalAgentDefaults(cfg, provider)
  const canReuseSessionConfig = session.provider === provider
  if (!hasNativeSession) {
    const patch: Record<string, string | null> = {}
    if (!canReuseSessionConfig) {
      patch.provider = provider
      patch.model = providerDefaults.model || null
      patch.effort = providerDefaults.effort || null
    } else {
      if (!session.model && providerDefaults.model) patch.model = providerDefaults.model
      if (!session.effort && providerDefaults.effort) patch.effort = providerDefaults.effort
    }
    if (Object.keys(patch).length) d.update(schema.globalSessions).set(patch).where(eq(schema.globalSessions.id, id)).run()
  }
  const ctx: GlobalChatJobCtx = {
    db: d, schema, sessionId: id, cwd: workdir,
    provider,
    // 不混用：codex 会话兜底用 codex 模型（空=Codex 默认），别把 claude 模型塞进 codex。
    model: (canReuseSessionConfig ? session.model : null) || providerDefaults.model || '',
    effort: (canReuseSessionConfig ? session.effort : null) || providerDefaults.effort,
    codexServiceTier: provider === defaults.provider ? defaults.codexServiceTier : null,
    lang: getCookie(event, 'mr-locale') || 'zh',
    allowDanger: !!allowDanger,
    ultracode: !!ultracode,
    assetsDir: resolve(process.cwd(), dirname(cfg.dbPath as string), 'issue-assets'),
  }
  void runGlobalChatJob(ctx, message).catch((e) => console.error('[global-chat] job failed', e))
  return { ok: true, cwd: workdir }
})

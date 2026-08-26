import { eq } from 'drizzle-orm'
import { z } from 'zod'
import os from 'node:os'
import { existsSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { schema } from '~core/db/client'
import { runGlobalChatJob, isGlobalChatting, isGlobalLive, type GlobalChatJobCtx } from '~core/global/pipeline'
import type { ReviewProvider } from '~core/agent/runners'
import { resolveGlobalAgentDefaults, runtimeGlobalAgentDefaults } from '../../../../utils/globalAgentConfig'
import { resolveLang } from '~core/agent/lang'
import { getAgentSettings } from '~core/agent/settings'

// Send one global session message (fire-and-forget; progress goes over SSE). May carry a cwd (/cd): validated to exist, then persisted on the session.
const Body = z.object({
  message: z.string().min(1).max(20000), cwd: z.string().optional(), allowDanger: z.boolean().optional(), ultracode: z.boolean().optional(), projectId: z.string().optional(),
  permissionMode: z.enum(['default', 'acceptEdits', 'plan', 'bypassPermissions']).optional(), // claude host only
})

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
  const { message, cwd, allowDanger, ultracode, projectId, permissionMode } = Body.parse((await readBody(event)) || {})
  const d = db()
  const session = d.select().from(schema.globalSessions).where(eq(schema.globalSessions.id, id)).get()
  if (!session) throw createError({ statusCode: 404, statusMessage: 'session 不存在' })
  if (isGlobalChatting(id) || isGlobalLive(id)) throw createError({ statusCode: 409, statusMessage: '上一条还在生成中，请等它完成或停止' })

  const cfg = useRuntimeConfig()
  const defaults = resolveGlobalAgentDefaults(d, cfg, projectId)

  // Working directory: session.cwd → the project's localPath → the user's home dir. If a cwd (/cd) is passed, validate and update it.
  const defaultCwd = existingPath(defaults.cwd)
  let workdir = existingPath(session.cwd) || defaultCwd || os.homedir()
  if (cwd && cwd.trim()) {
    workdir = cwd.trim()
    if (!existsSync(workdir)) throw createError({ statusCode: 400, statusMessage: `目录不存在: ${workdir}` })
    d.update(schema.globalSessions).set({ cwd: workdir }).where(eq(schema.globalSessions.id, id)).run()
  } else if ((session.cwd && session.cwd !== workdir) || (!session.cwd && defaultCwd)) {
    d.update(schema.globalSessions).set({ cwd: workdir }).where(eq(schema.globalSessions.id, id)).run()
  }

  // Until a native Claude/Codex session exists, let the current project config decide which provider the global assistant uses.
  // Once a native session exists, pin the original provider, so we never resume Codex from a Claude session or the other way round.
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
    // Never mix: a codex session falls back to a codex model (empty = Codex default); don't push a claude model into codex.
    model: (canReuseSessionConfig ? session.model : null) || providerDefaults.model || '',
    effort: (canReuseSessionConfig ? session.effort : null) || providerDefaults.effort,
    codexServiceTier: provider === defaults.provider ? defaults.codexServiceTier : null,
    lang: resolveLang(getCookie(event, 'mr-locale')),
    allowDanger,
    ultracode: !!ultracode,
    permissionMode: permissionMode ?? 'default',
    chrome: getAgentSettings(d, schema).chrome, // agent-config screen switch (PR_COCKPIT_CHROME=1 as the fallback default)
    assetsDir: resolve(process.cwd(), dirname(cfg.dbPath as string), 'issue-assets'),
  }
  void runGlobalChatJob(ctx, message).catch((e) => console.error('[global-chat] job failed', e))
  return { ok: true, cwd: workdir }
})

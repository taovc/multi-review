import { nanoid } from 'nanoid'
import { statSync } from 'node:fs'
import { z } from 'zod'
import { schema } from '~core/db/client'
import type { ReviewProvider } from '~core/agent/runners'
import { resolveGlobalAgentDefaults, runtimeGlobalAgentDefaults } from '../../utils/globalAgentConfig'

// 新建一段全局会话（空会话，session id 在第一轮对话时由 runner 回填）。
const Body = z.object({
  provider: z.enum(['claude', 'codex']).optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
  projectId: z.string().optional(),
  cwd: z.string().optional(),
  title: z.string().max(200).optional(),
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
  const b = Body.parse((await readBody(event).catch(() => ({}))) || {})
  const d = db()
  const cfg = useRuntimeConfig()
  const now = new Date().toISOString()
  const defaults = resolveGlobalAgentDefaults(d, cfg, b.projectId)
  const provider: ReviewProvider = b.provider ?? defaults.provider
  const providerDefaults = provider === defaults.provider ? defaults : runtimeGlobalAgentDefaults(cfg, provider)
  const row = {
    id: nanoid(),
    title: b.title?.trim() || null,
    provider,
    model: b.model?.trim() || (b.projectId ? providerDefaults.model : null) || null,
    effort: b.effort?.trim() || (b.projectId ? providerDefaults.effort : null) || null,
    cwd: existingPath(b.cwd) || existingPath(providerDefaults.cwd) || null,
    sessionId: null,
    codexSessionId: null,
    status: 'idle' as const,
    error: null,
    createdAt: now,
    lastUsedAt: now,
  }
  d.insert(schema.globalSessions).values(row).run()
  return row
})

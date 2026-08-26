import { nanoid } from 'nanoid'
import { and, desc, eq } from 'drizzle-orm'
import { statSync } from 'node:fs'
import { z } from 'zod'
import { schema } from '~core/db/client'
import { fetchPrMeta } from '~core/github/gh'
import { resolveLang } from '~core/agent/lang'
import type { ReviewProvider } from '~core/agent/runners'
import { resolveGlobalAgentDefaults, runtimeGlobalAgentDefaults } from '../../utils/globalAgentConfig'

// Create a session run (a persistent conversation bound to a workspace). Nothing runs until the first message.
//   pr_worktree     — idempotent per project + PR (reopening the tab never duplicates); PR metadata is fetched server-side
//   branch_worktree — a new feature branch cut from the project's default branch on the first turn
//   cwd             — any directory (the project's clone by default)
const Body = z.object({
  workspaceType: z.enum(['pr_worktree', 'branch_worktree', 'cwd']),
  projectId: z.string().optional(),
  prNumber: z.number().int().positive().optional(),
  cwd: z.string().optional(),
  provider: z.enum(['claude', 'codex']).optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
  title: z.string().max(200).optional(),
  description: z.string().max(20000).optional(), // branch_worktree: the requirement; pr_worktree: the reviewer's instruction
})

function existingDir(path?: string | null): string | null {
  const p = path?.trim()
  if (!p) return null
  try { return statSync(p).isDirectory() ? p : null } catch { return null }
}

export default defineEventHandler(async (event) => {
  const b = Body.parse((await readBody(event).catch(() => ({}))) || {})
  const d = db()
  const cfg = useRuntimeConfig()
  const now = new Date().toISOString()
  const lang = resolveLang(getCookie(event, 'mr-locale'))
  const project = b.projectId ? d.select().from(schema.projects).where(eq(schema.projects.id, b.projectId)).get() : null
  if (b.projectId && !project) throw createError({ statusCode: 404, statusMessage: '项目不存在' })

  if (b.workspaceType === 'pr_worktree') {
    if (!project) throw createError({ statusCode: 400, statusMessage: 'pr_worktree 需要 projectId' })
    if (!b.prNumber) throw createError({ statusCode: 400, statusMessage: 'PR 编号不合法' })
    if (!project.localPath) throw createError({ statusCode: 400, statusMessage: '项目未配置本地 clone 路径（worktree 需要它）' })
    const latest = () => d.select().from(schema.runs)
      .where(and(eq(schema.runs.kind, 'session'), eq(schema.runs.workspaceType, 'pr_worktree'), eq(schema.runs.projectId, project.id), eq(schema.runs.prNumber, b.prNumber!)))
      .orderBy(desc(schema.runs.createdAt)).get()
    const pre = latest()
    if (pre) return { id: pre.id, status: pre.status, created: false }
    const meta = await fetchPrMeta(project.repo, b.prNumber)
    if (!meta.branch) throw createError({ statusCode: 400, statusMessage: '拿不到 PR 分支' })
    const dup = latest() // no await between this check and the insert → no duplicate under concurrency
    if (dup) return { id: dup.id, status: dup.status, created: false }
    const rc = resolveReviewConfig(d, project)
    const id = nanoid()
    d.insert(schema.runs).values({
      id, kind: 'session', subkind: 'session', provider: rc.provider, model: rc.model || null, effort: rc.effort || null, codexServiceTier: rc.codexServiceTier,
      projectId: project.id, workspaceType: 'pr_worktree', prNumber: b.prNumber, branch: meta.branch, baseBranch: meta.baseBranch || project.defaultBranch || null,
      prAuthor: meta.author || null, title: b.title?.trim() || meta.title || null, description: b.description?.trim() || null, lang,
      status: 'idle', createdAt: now, updatedAt: now,
    }).run()
    return { id, status: 'idle', created: true }
  }

  if (b.workspaceType === 'branch_worktree') {
    if (!project) throw createError({ statusCode: 400, statusMessage: 'branch_worktree 需要 projectId' })
    if (!project.localPath) throw createError({ statusCode: 400, statusMessage: '项目未配置本地 clone 路径（开发需要读代码）' })
    if (!b.description?.trim()) throw createError({ statusCode: 400, statusMessage: '需要一句需求描述' })
    const rc = resolveReviewConfig(d, project)
    const id = nanoid()
    d.insert(schema.runs).values({
      id, kind: 'session', subkind: 'session', provider: rc.provider, model: rc.model || null, effort: rc.effort || null, codexServiceTier: rc.codexServiceTier,
      projectId: project.id, workspaceType: 'branch_worktree', baseBranch: project.defaultBranch, title: b.title?.trim() || null, description: b.description.trim(), lang,
      status: 'idle', createdAt: now, updatedAt: now,
    }).run()
    return { id, status: 'idle', created: true }
  }

  // cwd
  const defaults = resolveGlobalAgentDefaults(d, cfg, b.projectId)
  const provider: ReviewProvider = b.provider ?? defaults.provider
  const providerDefaults = provider === defaults.provider ? defaults : runtimeGlobalAgentDefaults(cfg, provider)
  const id = nanoid()
  d.insert(schema.runs).values({
    id, kind: 'session', subkind: 'session', provider,
    model: b.model?.trim() || (b.projectId ? providerDefaults.model : null) || null,
    effort: b.effort?.trim() || (b.projectId ? providerDefaults.effort : null) || null,
    projectId: project?.id ?? null, workspaceType: 'cwd', workspacePath: existingDir(b.cwd) || existingDir(providerDefaults.cwd) || null,
    title: b.title?.trim() || null, lang, status: 'idle', createdAt: now, updatedAt: now,
  }).run()
  return { id, status: 'idle', created: true }
})

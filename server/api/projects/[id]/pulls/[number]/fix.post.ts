import { nanoid } from 'nanoid'
import { and, eq } from 'drizzle-orm'
import { schema } from '~core/db/client'
import { fetchPrMeta } from '~core/github/gh'
import { resolveLang } from '~core/agent/lang'

// Create a "fix PR" chat task (lazily): insert one fixes row (status=open), no validation run, no queueing.
// The worktree is created lazily by ensureWorktree on the first chat message.
// If the PR already has a task, reuse it (opening the tab repeatedly doesn't create duplicates; discard is a hard delete, so no leftover rows).
export default defineEventHandler(async (event) => {
  const projectId = getRouterParam(event, 'id')!
  const prNumber = Number(getRouterParam(event, 'number'))
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'PR 编号不合法' })
  }
  const d = db()

  const project = d.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()
  if (!project) throw createError({ statusCode: 404, statusMessage: '项目不存在' })
  if (!project.localPath) throw createError({ statusCode: 400, statusMessage: '项目未配置本地 clone 路径（worktree 需要它）' })

  // Get the latest fix row for this PR (discard is a hard delete, so there are no leftover rows; if one exists, reuse it)
  const latest = () => {
    const rows = d
      .select()
      .from(schema.fixes)
      .where(and(eq(schema.fixes.projectId, projectId), eq(schema.fixes.prNumber, prNumber)))
      .all()
      .sort((a: any, b: any) => a.createdAt.localeCompare(b.createdAt))
    return rows.length ? rows[rows.length - 1]! : null
  }
  const pre = latest()
  if (pre) return { id: pre.id, status: pre.status }

  // Fetch PR metadata server-side (don't trust the client for branch/author/title)
  const meta = await fetchPrMeta(project.repo, prNumber)
  if (!meta.branch) throw createError({ statusCode: 400, statusMessage: '拿不到 PR 分支' })

  // Re-check: a concurrent request may have created it while fetchPrMeta was in flight. There is no
  // await between this SELECT and the INSERT below, so it runs atomically on Node's single thread →
  // no duplicate rows for the same PR under concurrency.
  const dup = latest()
  if (dup) return { id: dup.id, status: dup.status }

  const now = new Date().toISOString()
  const id = nanoid()
  d.insert(schema.fixes).values({
    id,
    projectId,
    prNumber,
    branch: meta.branch,
    baseRef: meta.baseBranch || project.defaultBranch || null, // PR target branch, used for three-dot diff
    prAuthor: meta.author || null,
    title: meta.title || null,
    lang: resolveLang(getCookie(event, 'mr-locale')),
    status: 'open',
    createdAt: now,
    updatedAt: now,
  }).run()

  return { id, status: 'open' }
})

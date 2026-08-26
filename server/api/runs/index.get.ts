import { and, desc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { schema } from '~core/db/client'
import { isRunBusy, fixStatusOf } from '~core/runs/session'

// List session runs: ?workspaceType=cwd|pr_worktree|branch_worktree &projectId= &page= &pageSize=
const Query = z.object({
  workspaceType: z.enum(['pr_worktree', 'branch_worktree', 'cwd']).optional(),
  projectId: z.string().optional(),
  page: z.coerce.number().int().min(0).default(0),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})

export default defineEventHandler((event) => {
  const q = Query.parse(getQuery(event))
  const d = db()
  const conds = [eq(schema.runs.kind, 'session')]
  if (q.workspaceType) conds.push(eq(schema.runs.workspaceType, q.workspaceType))
  if (q.projectId) conds.push(eq(schema.runs.projectId, q.projectId))
  const where = and(...conds)
  const total = Number(d.select({ n: sql<number>`COUNT(*)` }).from(schema.runs).where(where).get()?.n ?? 0)
  const rows = d.select().from(schema.runs).where(where).orderBy(desc(schema.runs.updatedAt)).limit(q.pageSize).offset(q.page * q.pageSize).all()
  return {
    runs: rows.map((r) => ({
      id: r.id, title: r.title, description: r.description, provider: r.provider, model: r.model, effort: r.effort, workspaceType: r.workspaceType, workspacePath: r.workspacePath,
      projectId: r.projectId, prNumber: r.prNumber, prUrl: r.prUrl, branch: r.branch, status: r.status, error: r.error, costUsd: r.costUsd,
      fixStatus: r.workspaceType === 'pr_worktree' ? fixStatusOf(r) : null, busy: isRunBusy(r.id),
      createdAt: r.createdAt, updatedAt: r.updatedAt, lastUsedAt: r.updatedAt,
    })),
    total, page: q.page, pageSize: q.pageSize, hasNext: (q.page + 1) * q.pageSize < total,
  }
})

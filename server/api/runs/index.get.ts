import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { schema } from '~core/db/client'
import { isRunBusy, fixStatusOf } from '~core/runs/session'

// List session runs: ?workspaceType=cwd|pr_worktree|branch_worktree (comma-separated for several) &projectId= &page= &pageSize=
const WS = ['pr_worktree', 'branch_worktree', 'cwd'] as const
type Ws = typeof WS[number]
const Query = z.object({
  workspaceType: z.string().optional().transform((s, ctx) => {
    if (!s) return undefined
    const list = s.split(',').map((x) => x.trim()).filter(Boolean)
    if (list.some((x) => !(WS as readonly string[]).includes(x))) { ctx.addIssue({ code: 'custom', message: 'invalid workspaceType' }); return z.NEVER }
    return list as Ws[]
  }),
  projectId: z.string().optional(),
  prNumber: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().min(0).default(0),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})

export default defineEventHandler((event) => {
  const q = Query.parse(getQuery(event))
  const d = db()
  const conds = [eq(schema.runs.kind, 'session')]
  if (q.workspaceType) conds.push(q.workspaceType.length === 1 ? eq(schema.runs.workspaceType, q.workspaceType[0]!) : inArray(schema.runs.workspaceType, q.workspaceType))
  if (q.projectId) {
    // Directory sessions created before the assistant was scoped to projects carry no projectId; adopt them by path.
    // Same rule as core/runs/adopt.ts: the clone itself or a path inside it (separator required), LIKE wildcards escaped.
    const base = (d.select({ localPath: schema.projects.localPath }).from(schema.projects).where(eq(schema.projects.id, q.projectId)).get()?.localPath ?? '').trim().replace(/\/+$/, '')
    const inside = `${base.replace(/[\\%_]/g, (m) => `\\${m}`)}/%`
    conds.push(base
      ? or(eq(schema.runs.projectId, q.projectId), and(isNull(schema.runs.projectId), eq(schema.runs.workspaceType, 'cwd'), or(eq(schema.runs.workspacePath, base), sql`${schema.runs.workspacePath} LIKE ${inside} ESCAPE '\\'`)))!
      : eq(schema.runs.projectId, q.projectId))
  }
  if (q.prNumber) conds.push(eq(schema.runs.prNumber, q.prNumber))
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

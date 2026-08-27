import { readFileSync } from 'node:fs'
import { eq } from 'drizzle-orm'
import { z } from 'zod'

// A golden set: PRs whose real problems were labelled by a human, replayed at a fixed head sha so that
// skill versions / models / the verify pass can be compared on identical input.
export const GoldenLabelSchema = z.object({
  id: z.string(),
  severity: z.enum(['High', 'Medium', 'Low']).default('Medium'),
  location: z.string().default(''), // path[:line]; only the path is used for matching
  title: z.string(),
  problem: z.string().default(''),
  mustFind: z.boolean().default(true), // false = nice-to-have: missing it is not a false negative
})
export const GoldenCaseSchema = z.object({
  prNumber: z.number().int().positive(),
  headSha: z.string().min(7),
  branch: z.string().min(1),
  baseBranch: z.string().optional(),
  labels: z.array(GoldenLabelSchema).default([]),
})
export const GoldenSchema = z.object({
  name: z.string().min(1),
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
  defaultBranch: z.string().default('main'),
  projectId: z.string().optional(), // the pr-cockpit project whose local clone is used (or pass --project on the CLI)
  cases: z.array(GoldenCaseSchema).min(1),
})
export type Golden = z.infer<typeof GoldenSchema>
export type GoldenCase = z.infer<typeof GoldenCaseSchema>
export type GoldenLabel = z.infer<typeof GoldenLabelSchema>

// Bootstrap a golden set from real reviews: every finding a human accepted (ticked and posted, or ticked by hand) is a
// label at the review's head sha. Reviews without accepted findings or without a recorded head are skipped.
export function goldenFromReviews(db: any, schema: any, project: { id: string; name: string; repo: string; defaultBranch: string }, opts: { limit?: number } = {}): Golden {
  const rows = db.select().from(schema.reviews).where(eq(schema.reviews.projectId, project.id)).all() as any[]
  const cases: GoldenCase[] = []
  for (const r of rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))) {
    if (!r.headSha || !r.branch) continue
    const findings = (db.select().from(schema.findings).where(eq(schema.findings.reviewId, r.id)).all() as any[])
      .filter((f) => f.humanAcceptedAt || f.postedPostId || (f.checked && f.checkedBy === 'human'))
      .sort((a, b) => a.sortOrder - b.sortOrder)
    if (!findings.length) continue
    cases.push({
      prNumber: r.prNumber, headSha: r.headSha, branch: r.branch, baseBranch: project.defaultBranch,
      labels: findings.map((f) => ({ id: f.fid, severity: (['High', 'Medium', 'Low'].includes(f.severity) ? f.severity : 'Medium') as 'High' | 'Medium' | 'Low', location: f.location || '', title: f.title, problem: f.problem || '', mustFind: true })),
    })
    if (opts.limit && cases.length >= opts.limit) break
  }
  return { name: project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'golden', repo: project.repo, defaultBranch: project.defaultBranch, projectId: project.id, cases }
}

export function loadGolden(path: string): Golden {
  return GoldenSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
}

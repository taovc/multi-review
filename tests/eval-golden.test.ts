import assert from 'node:assert/strict'
import { getDb, schema } from '../core/db/client'
import { goldenFromReviews, GoldenSchema } from '../core/eval/golden'

// A golden set bootstrapped from real reviews: human-accepted / posted findings become labels at the review's head.
const d = getDb(':memory:')
const now = new Date().toISOString()
d.insert(schema.projects).values({ id: 'P', name: 'My Proj', slug: 'my-proj', repo: 'o/r', defaultBranch: 'main', createdAt: now }).run()
const review = (id: string, pr: number, headSha: string | null, extra: Record<string, unknown> = {}) =>
  d.insert(schema.reviews).values({ id, projectId: 'P', prNumber: pr, prUrl: 'u', branch: `b${pr}`, headSha, status: 'posted', prState: 'open', createdAt: `${now.slice(0, 19)}${pr}`, updatedAt: now, ...extra } as any).run()
const finding = (id: string, reviewId: string, fid: string, extra: Record<string, unknown>) =>
  d.insert(schema.findings).values({ id, reviewId, fid, severity: 'High', title: `t-${fid}`, location: `src/${fid}.ts:1`, problem: 'p', introducedByPr: true, checked: false, sortOrder: Number(fid.replace(/\D/g, '')), createdAt: now, ...extra } as any).run()

review('R1', 10, 'sha10abcdef')
finding('f1', 'R1', 'F1', { checked: true, checkedBy: 'human', humanAcceptedAt: now })
finding('f2', 'R1', 'F2', { checked: true, checkedBy: 'engine' }) // machine-checked → not a label
finding('f3', 'R1', 'F3', { postedPostId: 'post1' })
review('R2', 11, 'sha11abcdef') // no accepted findings → skipped
finding('f4', 'R2', 'F1', { checked: false })
review('R3', 12, null) // no head sha → skipped
finding('f5', 'R3', 'F1', { humanAcceptedAt: now })

const g = goldenFromReviews(d, schema, { id: 'P', name: 'My Proj', repo: 'o/r', defaultBranch: 'main' })
GoldenSchema.parse(g)
assert.equal(g.name, 'my-proj')
assert.equal(g.cases.length, 1)
assert.equal(g.cases[0]!.prNumber, 10)
assert.equal(g.cases[0]!.headSha, 'sha10abcdef')
assert.equal(g.cases[0]!.branch, 'b10')
assert.deepEqual(g.cases[0]!.labels.map((l) => [l.id, l.mustFind]), [['F1', true], ['F3', true]])
assert.equal(goldenFromReviews(d, schema, { id: 'P', name: 'x', repo: 'o/r', defaultBranch: 'main' }, { limit: 0 }).cases.length, 1)
console.log('eval-golden: ok')

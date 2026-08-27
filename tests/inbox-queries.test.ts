import assert from 'node:assert/strict'
import { nanoid } from 'nanoid'
import { eq } from 'drizzle-orm'
import { getDb, schema } from '../core/db/client'
import { inboxOverview } from '../core/inbox/queries'
import { createRun, finishRun } from '../core/runs/store'

// Inbox over a seeded in-memory DB: pending prompt, draft to triage, author update, recent error.
const d = getDb(':memory:')
const now = new Date().toISOString()
const projectId = nanoid()
d.insert(schema.projects).values({ id: projectId, name: 'P', slug: 'p', repo: 'o/r', createdAt: now, updatedAt: now } as any).run()
const draft = nanoid(), updated = nanoid(), running = nanoid()
let pr = 0
for (const [id, status, authorUpdated] of [[draft, 'draft', false], [updated, 'posted', true], [running, 'reviewing', true]] as const) {
  d.insert(schema.reviews).values({ id, projectId, prNumber: ++pr, prUrl: 'https://x/1', title: 't', status, authorUpdated, createdAt: now, updatedAt: now } as any).run()
}
d.insert(schema.findings).values({ id: nanoid(), reviewId: draft, fid: 'F1', severity: 'High', title: 'x', checked: false, createdAt: now } as any).run()
d.insert(schema.findings).values({ id: nanoid(), reviewId: draft, fid: 'F2', severity: 'Low', title: 'y', checked: true, createdAt: now } as any).run()
// error run in range + an old one out of range
const errRun = createRun(d, schema, { kind: 'review', subkind: 'review', provider: 'claude', projectId, reviewId: draft, workspaceType: 'pr_worktree', workspacePath: '/w', model: 'm', effort: '', lang: 'en' } as any)
finishRun(d, schema, errRun, { status: 'error', error: 'boom' })
const oldRun = createRun(d, schema, { kind: 'review', subkind: 'review', provider: 'claude', projectId, reviewId: draft, workspaceType: 'pr_worktree', workspacePath: '/w', model: 'm', effort: '', lang: 'en' } as any)
finishRun(d, schema, oldRun, { status: 'error', error: 'old' })
d.update(schema.runs).set({ endedAt: '2000-01-01T00:00:00.000Z', updatedAt: '2000-01-01T00:00:00.000Z', startedAt: '2000-01-01T00:00:00.000Z' }).where(eq(schema.runs.id, oldRun)).run()
// pending prompt on a session run
const sid = nanoid()
createRun(d, schema, { id: sid, kind: 'session', subkind: 'session', provider: 'claude', workspaceType: 'cwd', workspacePath: '/x', model: 'm', effort: '', lang: 'en', title: 'my session' } as any)
d.insert(schema.permissionRequests).values({ id: nanoid(), runId: sid, kind: 'tool', toolName: 'Bash', input: '{}', status: 'pending', createdAt: now } as any).run()
d.insert(schema.permissionRequests).values({ id: nanoid(), runId: sid, kind: 'tool', toolName: 'Bash', input: '{}', status: 'allowed', createdAt: now } as any).run()

const o = inboxOverview(d, { sinceIso: new Date(Date.now() - 24 * 3600_000).toISOString() })
assert.equal(o.prompts.length, 1)
assert.equal(o.prompts[0]!.sessionTitle, 'my session')
assert.deepEqual(o.drafts.map(r => r.reviewId), [draft])
assert.equal(o.drafts[0]!.findings, 2)
assert.equal(o.drafts[0]!.unchecked, 1)
assert.deepEqual(o.errors.map(e => e.runId), [errRun], 'only errors within the window')
assert.equal(o.errors[0]!.error, 'boom')
assert.equal(o.counts.total, 3)
assert.equal(o.prompts[0]!.workspaceType, 'cwd')
console.log('inbox-queries.test.ts ✓')

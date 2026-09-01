import assert from 'node:assert/strict'
import { nanoid } from 'nanoid'
import { authorMoveOf, isRecheckResolved, stanceOf } from '../core/recheckAxes'
import { reviewFindingStats } from '../core/automation/findings'
import { getDb, schema } from '../core/db/client'

// A recheck row answers two questions, and everything downstream has to read the right one. When the two shared a
// column, every consumer read that column; splitting them without moving the consumers meant a stance the agent
// expressed was written and then ignored — including 'retracted', which reaches GitHub as a live comment and keeps
// the auto-fix engine re-fixing a finding the review already took back. These are the reader-side guards.

// ── the two axes, including rows written before the split ──
assert.equal(stanceOf({ status: 'fixed', stance: 'retracted' }), 'retracted')
assert.equal(authorMoveOf({ status: 'fixed', stance: 'retracted' }), 'fixed', 'the axes are independent: fixed AND withdrawn is sayable')
assert.equal(stanceOf({ status: 'fixed' }), null, 'a round that only judged the author expresses no stance')
assert.equal(stanceOf({ status: 'retracted' }), 'retracted', 'an old row kept its stance word in status')
assert.equal(authorMoveOf({ status: 'retracted' }), null, 'and said nothing about the author')
assert.equal(stanceOf(null), null)
assert.equal(authorMoveOf(undefined), null)

// ── resolved: either we withdrew it, or the author dealt with it ──
assert.equal(isRecheckResolved({ status: 'unaddressed', stance: 'retracted' }), true, 'we took it back — nothing left to chase')
assert.equal(isRecheckResolved({ status: 'fixed', stance: 'kept' }), true)
assert.equal(isRecheckResolved({ status: 'replied', stance: 'kept' }), true)
assert.equal(isRecheckResolved({ status: 'unaddressed', stance: 'kept' }), false)
assert.equal(isRecheckResolved({ status: 'partial', stance: 'adjusted' }), false, 'reworded but still standing')
assert.equal(isRecheckResolved({ status: 'unaddressed', stance: 'discuss' }), false)
assert.equal(isRecheckResolved({ status: 'retracted' }), true, 'old row')
assert.equal(isRecheckResolved(null), false, 'never rechecked = still to handle')

// ── the auto-fix engine must stop chasing a retracted finding ──
{
  const d = getDb(':memory:')
  const now = new Date().toISOString()
  d.insert(schema.projects).values({ id: 'P', name: 'p', slug: 'p', repo: 'o/r', defaultBranch: 'main', createdAt: now }).run()
  d.insert(schema.reviews).values({ id: 'RV', projectId: 'P', prNumber: 1, prUrl: 'u', status: 'draft', createdAt: now, updatedAt: now } as any).run()
  const mk = (id: string, fid: string, sortOrder: number) =>
    d.insert(schema.findings).values({ id, reviewId: 'RV', fid, severity: 'High', title: fid, introducedByPr: true, checked: false, sortOrder, createdAt: now } as any).run()
  const rc = (findingId: string, round: number, status: string, stance: string | null) =>
    d.insert(schema.findingRechecks).values({ id: nanoid(), findingId, round, status, stance, at: `2026-01-0${round}T00:00:00Z` } as any).run()

  mk('a', 'F1', 0) // still open
  mk('b', 'F2', 1) // withdrawn by us in the latest round
  mk('c', 'F3', 2) // fixed by the author
  mk('d', 'F4', 3) // never rechecked
  rc('a', 1, 'unaddressed', 'kept')
  rc('b', 1, 'unaddressed', 'kept')
  rc('b', 2, 'unaddressed', 'retracted') // the author did nothing; we changed our mind
  rc('c', 1, 'fixed', 'kept')

  const stats = reviewFindingStats(d, schema, 'RV')
  const fids = stats.actionableFindings.map((f: any) => f.fid).sort()
  assert.deepEqual(fids, ['F1', 'F4'], 'a retracted finding drops out of the work list; a fixed one too')
  assert.equal(stats.total, 4)
  assert.equal(stats.actionable, 2)
}

console.log('recheck-axes: ok')

import assert from 'node:assert/strict'
import { CodexReviewError, parseCodexRecheckJson } from '../core/agent/codexReview'

// ── recheck: all fields required, structure matches RecheckSchema ──
const recheck = parseCodexRecheckJson(JSON.stringify({
  rechecks: [
    { fid: 'F1', status: 'fixed', stance: 'kept', stanceReason: '', text: '已在 abc123 修复' },
    // the two axes are independent: the author fixed it AND we no longer think it was worth raising
    { fid: 'F2', status: 'fixed', stance: 'retracted', stanceReason: '按 reviewer 的范围要求，这条属于扩大 review', text: '' },
  ],
  newFindings: [{ severity: 'Medium', title: 'regression', location: 'core/c.ts:3', problem: 'p', detail: 'd', fix: 'f', text: '在 def456 引入' }],
  conclusion: '还剩 1 个 blocking',
}))
assert.equal(recheck.rechecks[0]?.status, 'fixed')
assert.equal(recheck.rechecks[0]?.stance, 'kept')
assert.equal(recheck.rechecks[1]?.stance, 'retracted', 'stance is judged separately from what the author did')
assert.ok(recheck.rechecks[1]?.stanceReason, 'a changed stance carries its reason')
assert.equal(recheck.newFindings[0]?.severity, 'Medium')

// Bad JSON → CodexReviewError
assert.throws(
  () => parseCodexRecheckJson('not-json'),
  (error) => error instanceof CodexReviewError && /invalid JSON/i.test(error.message),
)

import assert from 'node:assert/strict'
import { CodexReviewError, parseCodexGuidedJson, parseCodexRecheckJson } from '../core/agent/codexReview'

// ── guided: fid null means "new finding" → should be absent after parsing (zod optional doesn't accept null) ──
const guided = parseCodexGuidedJson(JSON.stringify({
  findings: [
    {
      fid: 'F1',
      severity: 'High',
      title: 'kept finding',
      location: 'core/a.ts:1',
      problem: 'p',
      detail: 'd',
      fix: 'f',
      introducedByPr: true,
      response: { status: 'kept', text: '维持原判' },
    },
    {
      fid: null, // new finding: no fid
      severity: 'Low',
      title: 'new finding',
      location: 'core/b.ts:2',
      problem: 'p',
      detail: 'd',
      fix: 'f',
      introducedByPr: true,
      response: { status: 'new', text: '新引入' },
    },
  ],
  logic: 'L',
  quality: 'Q',
  risk: 'R',
  conclusion: 'C',
  requirement: 'Req',
  testPath: 'T',
}))

assert.equal(guided.findings.length, 2)
assert.equal(guided.findings[0]?.fid, 'F1')
assert.equal(guided.findings[1]?.fid, undefined) // null → absent
assert.equal(guided.findings[1]?.response?.status, 'new')

// Code fences get stripped too
const fenced = parseCodexGuidedJson('```json\n' + JSON.stringify({
  findings: [], logic: '', quality: '', risk: '', conclusion: '', requirement: '', testPath: '',
}) + '\n```')
assert.equal(fenced.findings.length, 0)

// ── recheck: all fields required, structure matches RecheckSchema ──
const recheck = parseCodexRecheckJson(JSON.stringify({
  rechecks: [{ fid: 'F1', status: 'fixed', text: '已在 abc123 修复' }],
  newFindings: [{ severity: 'Medium', title: 'regression', location: 'core/c.ts:3', problem: 'p', detail: 'd', fix: 'f', text: '在 def456 引入' }],
  conclusion: '还剩 1 个 blocking',
}))
assert.equal(recheck.rechecks[0]?.status, 'fixed')
assert.equal(recheck.newFindings[0]?.severity, 'Medium')

// Bad JSON → CodexReviewError
assert.throws(
  () => parseCodexRecheckJson('not-json'),
  (error) => error instanceof CodexReviewError && /invalid JSON/i.test(error.message),
)

import assert from 'node:assert/strict'
import { judge, pathOf, prf, similarity, tokens } from '../core/eval/judge'
import { GoldenSchema } from '../core/eval/golden'
import { VerifyResultSchema, buildVerifyPrompt, verdictMap } from '../core/agent/verify'

// Path normalisation: line suffixes and ./ prefixes are ignored, case-insensitive.
assert.equal(pathOf('src/a/B.ts:12'), 'src/a/b.ts')
assert.equal(pathOf('./src/a.ts#L3'), 'src/a.ts')
assert.equal(pathOf('src/a.ts (line 4)'), 'src/a.ts')
assert.equal(pathOf(null), '')

// Tokens drop stopwords and split CJK per character.
assert.deepEqual([...tokens('The refund amount is not validated')].sort(), ['amount', 'refund', 'validated'])
assert.ok(tokens('退款金额未校验').has('退款'))

const labels = GoldenSchema.parse({
  name: 'g', repo: 'o/r', cases: [{ prNumber: 1, headSha: 'abcdef0', branch: 'b', labels: [
    { id: 'L1', location: 'src/refund.ts:42', title: 'Refund amount is not validated against the captured amount', problem: 'over-refund reaches the gateway' },
    { id: 'L2', location: 'src/refund.ts', title: 'Unused import of formatMoney', mustFind: false },
    { id: 'L3', location: 'src/auth.ts', title: 'Session token compared with == instead of timing-safe compare' },
  ] }],
}).cases[0]!.labels

// Same file, overlapping wording → match; different file → never a match even with identical titles.
assert.ok(similarity({ fid: 'F1', severity: 'High', title: 'Refund amount not validated vs captured amount', location: 'src/refund.ts:40', problem: '' }, labels[0]!) >= 0.3)
assert.equal(similarity({ fid: 'F1', severity: 'High', title: labels[0]!.title, location: 'src/other.ts', problem: '' }, labels[0]!), 0)

const j = judge([
  { fid: 'F1', severity: 'High', title: 'Refund amount is not validated against the captured amount', location: 'src/refund.ts:45', problem: 'over-refund' },
  { fid: 'F2', severity: 'Low', title: 'Missing null check on user', location: 'src/user.ts:10', problem: '' },
], labels)
assert.equal(j.tp, 1)
assert.equal(j.fp, 1) // F2 matches nothing
assert.equal(j.fn, 1) // L3 must be found and was not; L2 is nice-to-have
assert.deepEqual(j.missedLabelIds.sort(), ['L2', 'L3'])
assert.deepEqual(j.unmatchedFids, ['F2'])
assert.deepEqual(j.matches.map((m) => [m.fid, m.labelId]), [['F1', 'L1']])

// One label is matched at most once: two near-duplicate findings count as 1 TP + 1 FP.
const dup = judge([
  { fid: 'F1', severity: 'High', title: 'Refund amount not validated against captured amount', location: 'src/refund.ts', problem: '' },
  { fid: 'F2', severity: 'High', title: 'Refund amount validation missing (captured amount)', location: 'src/refund.ts', problem: '' },
], [labels[0]!])
assert.equal(dup.tp, 1)
assert.equal(dup.fp, 1)

assert.deepEqual(prf(2, 2, 2), { precision: 0.5, recall: 0.5, f1: 0.5 })
assert.deepEqual(prf(0, 0, 0), { precision: null, recall: null, f1: null })

// Verify pass: verdict map defaults to 'unsure' for fids the verifier skipped; the prompt lists every finding.
const vm = verdictMap(VerifyResultSchema.parse({ verdicts: [{ fid: 'F1', verdict: 'refuted', reason: 'already validated in service layer' }] }), ['F1', 'F2'])
assert.equal(vm.get('F1')?.verdict, 'refuted')
assert.equal(vm.get('F2')?.verdict, 'unsure')
const prompt = buildVerifyPrompt({ cwd: '/tmp', repo: 'o/r', prNumber: 7, branch: 'b', defaultBranch: 'main', model: '', findings: [{ fid: 'F1', severity: 'High', title: 't1', location: 'a.ts:1', problem: 'p', detail: null }, { fid: 'F2', severity: 'Low', title: 't2', location: null, problem: null, detail: null }] })
assert.match(prompt, /F1 \[High\] t1/)
assert.match(prompt, /F2 \[Low\] t2/)
assert.match(prompt, /"verdicts"/)

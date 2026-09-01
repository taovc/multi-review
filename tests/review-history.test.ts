import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// The re-review's context layer: what gets pushed into the prompt, what is left on disk for the agent to fetch, how
// rounds and one-shot instructions are counted, and that a deleted task leaves nothing behind.
// DB_PATH decides where history directories live — point it at a throwaway dir before importing.
const tmp = mkdtempSync(path.join(tmpdir(), 'pr-cockpit-history-'))
process.env.DB_PATH = path.join(tmp, 'cockpit.db')

const {
  ROUND_EVENT, INSTRUCTION_EVENT, buildFindingIndex, buildHistoryDoc, computeRoundIntent,
  loadFindingHistory, recordRoundInstruction, removeReviewHistory, reviewHistoryDir, reviewHistoryRootFor,
  sweepOrphanHistories, writeReviewHistory,
} = await import('../core/agent/reviewHistory')
const { getDb, schema } = await import('../core/db/client')
const { nanoid } = await import('nanoid')

const root = reviewHistoryRootFor(process.env.DB_PATH!)
const d = getDb(':memory:')
const now = new Date().toISOString()
d.insert(schema.projects).values({ id: 'P', name: 'p', slug: 'p', repo: 'o/r', defaultBranch: 'main', createdAt: now }).run()
d.insert(schema.reviews).values({ id: 'RV', projectId: 'P', prNumber: 7, prUrl: 'u', status: 'draft', headSha: 'sha-old', createdAt: now, updatedAt: now } as any).run()

const ev = (kind: string, ts: string, message?: string) =>
  d.insert(schema.events).values({ id: nanoid(), reviewId: 'RV', ts, kind, message: message ?? null }).run()

// ── round counting + one-shot instructions ──
{
  ev(INSTRUCTION_EVENT, '2026-01-01T00:00:00Z', 'only look at permission boundaries')
  ev(ROUND_EVENT, '2026-01-01T01:00:00Z', 'round 1')
  ev(INSTRUCTION_EVENT, '2026-01-01T02:00:00Z', 'stop widening the scope')

  // What binds the round is what stands in the box now — that is what pressing the button promises.
  const i = computeRoundIntent(d, schema, 'RV', 'sha-new', 'sha-old', 'stop widening the scope')
  assert.equal(i.round, 2)
  assert.equal(i.hasNewCommits, true)
  assert.equal(i.instruction, 'stop widening the scope')
  assert.deepEqual(i.pastInstructions.map((x) => x.text), ['only look at permission boundaries'], 'earlier, different instructions are evidence of steering')
  assert.equal(i.sinceSha, 'sha-old')
  assert.equal(i.lastRoundAt, '2026-01-01T01:00:00Z')

  // The box keeps its text between rounds, so the standing instruction must not read as a repeated correction.
  assert.ok(!i.pastInstructions.some((x) => x.text === i.instruction), 'the current instruction is never also listed as past steering')

  // Changing your mind mid-review: the new text binds, the old one becomes history.
  const j = computeRoundIntent(d, schema, 'RV', 'sha-new', 'sha-old', 'actually go wide again')
  assert.equal(j.instruction, 'actually go wide again')
  assert.deepEqual(j.pastInstructions.map((x) => x.text).sort(), ['only look at permission boundaries', 'stop widening the scope'])

  // Clearing the box means no instruction binds this round, whatever was said before.
  assert.equal(computeRoundIntent(d, schema, 'RV', 'sha-new', 'sha-old', '   ').instruction, null)

  assert.equal(computeRoundIntent(d, schema, 'RV', 'sha-old', 'sha-old', null).hasNewCommits, false, 'same head = the author pushed nothing')
  assert.equal(computeRoundIntent(d, schema, 'RV', 'sha-new', null, null).hasNewCommits, false, 'no previous head recorded = do not claim new commits')
}

// ── the instruction log records changes of direction, not every resubmission of the same box ──
{
  const count = () => d.select().from(schema.events).all().length
  const before = count()
  recordRoundInstruction(d, schema, 'RV', 'stop widening the scope', nanoid(), '2026-01-01T02:30:00Z')
  assert.equal(count(), before, 'the box still holds last round\'s text; resubmitting it is not a new correction')

  recordRoundInstruction(d, schema, 'RV', '   ', nanoid(), '2026-01-01T02:31:00Z')
  assert.equal(count(), before, 'blank is not an instruction')

  ev(ROUND_EVENT, '2026-01-01T03:00:00Z', 'round 2')
  recordRoundInstruction(d, schema, 'RV', 'stop widening the scope', nanoid(), '2026-01-01T04:00:00Z')
  assert.equal(count(), before + 1, 'a new round alone does not make the unchanged text a new correction (+ the round event only)')

  recordRoundInstruction(d, schema, 'RV', 'now check the tests too', nanoid(), '2026-01-01T05:00:00Z')
  assert.equal(count(), before + 2, 'changed text is logged')
  assert.equal(computeRoundIntent(d, schema, 'RV', 'a', 'b', null).round, 3)
}

// ── findings + their rounds ──
{
  d.insert(schema.findings).values({ id: 'f1', reviewId: 'RV', fid: 'F1', severity: 'High', title: 'tenant scope missing', location: 'a.ts:1', problem: 'reads every company', detail: 'dd', fix: 'scope it', introducedByPr: true, checked: true, humanAcceptedAt: now, notes: 'I agree', sortOrder: 0, createdAt: now } as any).run()
  d.insert(schema.findings).values({ id: 'f2', reviewId: 'RV', fid: 'F2', severity: 'Low', title: 'stale comment', location: 'b.ts:9', problem: 'says unused', introducedByPr: true, checked: false, sortOrder: 1, createdAt: now } as any).run()
  d.insert(schema.findingRechecks).values({ id: nanoid(), findingId: 'f1', round: 1, status: 'unaddressed', stance: 'kept', text: 'still not scoped', at: '2026-01-01T01:00:00Z' } as any).run()
  d.insert(schema.findingRechecks).values({ id: nanoid(), findingId: 'f1', round: 2, status: 'fixed', stance: 'retracted', stanceReason: 'out of the scope the reviewer set', text: 'fixed in abc123', at: '2026-01-01T03:00:00Z' } as any).run()

  const hist = loadFindingHistory(d, schema, 'RV', { includeRounds: true })
  assert.equal(hist.length, 2)
  assert.equal(hist[0]!.fid, 'F1')
  assert.equal(hist[0]!.roundTexts.length, 2)
  assert.equal(hist[1]!.roundTexts.length, 0)

  // The index is the trigger: identity + trace, never the bulky text (that is what the file is for).
  const index = buildFindingIndex(hist)
  assert.match(index, /F1 \[High\].*r1:unaddressed\/kept → r2:fixed\/retracted/)
  assert.match(index, /ticked-for-posting, accepted-by-reviewer/)
  assert.match(index, /F2 \[Low\].*never re-reviewed/)
  assert.ok(!index.includes('reads every company'), 'the index must not carry the finding bodies')
  assert.ok(!index.includes('fixed in abc123'), 'nor the round texts')

  // The file is where the bulk lives.
  const intent = computeRoundIntent(d, schema, 'RV', 'sha-new', 'sha-old', 'stop widening the scope')
  const doc = buildHistoryDoc({
    reviewId: 'RV', repo: 'o/r', prNumber: 7, intent, findings: hist,
    globalNotes: 'this module is being deleted next sprint', fetchErrors: [],
    timeline: [
      { kind: 'comment', actor: 'author', isBot: false, at: '2026-01-01T05:00:00Z', body: 'addressed in the last push' },
      { kind: 'comment', actor: 'author', isBot: false, at: '2025-12-01T00:00:00Z', body: 'ancient history' },
    ],
    reviewComments: [
      { id: 1, path: 'a.ts', line: 3, body: 'why not scoped?', author: 'me', isBot: false, inReplyToId: null, createdAt: '2026-01-01T05:01:00Z' },
    ],
    since: '2026-01-01T03:00:00Z',
  })
  assert.match(doc, /round 3/)
  assert.match(doc, /reads every company/, 'the file carries what the index left out')
  assert.match(doc, /out of the scope the reviewer set/, 'including why a stance changed')
  assert.match(doc, /do not quietly drop it/, 'a hand-accepted finding is flagged')
  assert.match(doc, /addressed in the last push/)
  assert.match(doc, /new since the last round/, 'what arrived since the last round is marked')
  assert.match(doc, /ancient history/, 'older conversation stays: a late verdict can hinge on an early reply, and nothing tells the agent to go fetch it')
  assert.match(doc, /why not scoped\?/)
  assert.match(doc, /\*\*for this round\*\*/)
  assert.match(doc, /deleted next sprint/, "the reviewer's standing note reaches every round")

  // A failed fetch must never read as "the author said nothing".
  const broken = buildHistoryDoc({
    reviewId: 'RV', repo: 'o/r', prNumber: 7, intent, findings: hist,
    globalNotes: null, fetchErrors: ['PR conversation: rate limited'],
    timeline: [], reviewComments: [], since: null,
  })
  assert.match(broken, /Incomplete — GitHub would not return/)
  assert.match(broken, /not evidence of silence/)
}

// ── the file on disk, and what happens to it ──
{
  const { path: p, bytes } = writeReviewHistory(root, 'RV', '# hello\n')
  assert.ok(existsSync(p))
  assert.ok(bytes > 0)
  assert.ok(!p.includes('worktree'), 'never inside a worktree: the agent judges the checkout with git')
  assert.equal(path.dirname(p), reviewHistoryDir(root, 'RV'))

  mkdirSync(reviewHistoryDir(root, 'ORPHAN'), { recursive: true })
  writeFileSync(path.join(reviewHistoryDir(root, 'ORPHAN'), 'review-history.md'), 'x')
  assert.equal(sweepOrphanHistories(root, new Set(['RV'])), 1, 'a directory no review claims is swept at startup')
  assert.ok(existsSync(p), 'the live one survives')

  removeReviewHistory(root, 'RV')
  assert.ok(!existsSync(reviewHistoryDir(root, 'RV')), 'deleting the task takes its history with it')
  assert.equal(sweepOrphanHistories(root, new Set()), 0, 'sweeping an empty root is a no-op')
  assert.ok(root.startsWith(tmp), 'the root is derived from the db path the caller was given')
}

// ── did it open what we prepared: reported by the agent loop, which sees untruncated tool input ──
{
  const { touchesHistory } = await import('../core/agent/recheck')
  const hp = '/var/data/review-history/RV/review-history.md'
  assert.equal(touchesHistory({ file_path: hp }, hp), true)
  assert.equal(touchesHistory({ command: `sed -n '1,80p' ${hp}` }, hp), true, 'opened with a shell tool, not Read')
  assert.equal(touchesHistory({ pattern: 'stance', path: '/var/data/review-history/RV' }, hp), false, 'the directory alone is not the file')
  assert.equal(touchesHistory({ command: 'git diff HEAD~1..HEAD' }, hp), false)
  assert.equal(touchesHistory(undefined, hp), false)
}

rmSync(tmp, { recursive: true, force: true })
console.log('review-history: ok')

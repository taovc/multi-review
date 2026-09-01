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
  ROUND_EVENT, INSTRUCTION_EVENT, buildFindingIndex, buildHistoryDoc, computeRoundIntent, historyWasRead,
  loadFindingHistory, recordRoundInstruction, removeReviewHistory, reviewHistoryDir, reviewHistoryRoot,
  sweepOrphanHistories, writeReviewHistory,
} = await import('../core/agent/reviewHistory')
const { getDb, schema } = await import('../core/db/client')
const { nanoid } = await import('nanoid')

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

  const i = computeRoundIntent(d, schema, 'RV', 'sha-new', 'sha-old')
  assert.equal(i.round, 2)
  assert.equal(i.hasNewCommits, true)
  assert.equal(i.instruction, 'stop widening the scope', 'only an instruction newer than the last round binds this one')
  assert.deepEqual(i.pastInstructions.map((x) => x.text), ['only look at permission boundaries'], 'earlier ones stay as evidence, not as constraints')
  assert.equal(i.sinceSha, 'sha-old')
  assert.equal(i.lastRoundAt, '2026-01-01T01:00:00Z')

  assert.equal(computeRoundIntent(d, schema, 'RV', 'sha-old', 'sha-old').hasNewCommits, false, 'same head = the author pushed nothing')
  assert.equal(computeRoundIntent(d, schema, 'RV', 'sha-new', null).hasNewCommits, false, 'no previous head recorded = do not claim new commits')
}

// ── recording an instruction: repeatable across rounds, deduped within one ──
{
  const before = d.select().from(schema.events).all().length
  recordRoundInstruction(d, schema, 'RV', 'stop widening the scope', nanoid(), '2026-01-01T02:30:00Z')
  assert.equal(d.select().from(schema.events).all().length, before, 'the same text again for the same round is a double click, not a new instruction')

  recordRoundInstruction(d, schema, 'RV', '   ', nanoid(), '2026-01-01T02:31:00Z')
  assert.equal(d.select().from(schema.events).all().length, before, 'blank is not an instruction')

  ev(ROUND_EVENT, '2026-01-01T03:00:00Z', 'round 2')
  recordRoundInstruction(d, schema, 'RV', 'stop widening the scope', nanoid(), '2026-01-01T04:00:00Z')
  assert.equal(d.select().from(schema.events).all().length, before + 2, 'the same text for a NEW round binds again (+ the round event)')
  assert.equal(computeRoundIntent(d, schema, 'RV', 'a', 'b').round, 3)
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
  const intent = computeRoundIntent(d, schema, 'RV', 'sha-new', 'sha-old')
  const doc = buildHistoryDoc({
    reviewId: 'RV', repo: 'o/r', prNumber: 7, intent, findings: hist,
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
  assert.ok(!doc.includes('ancient history'), 'conversation older than the last round is not repeated')
  assert.match(doc, /why not scoped\?/)
  assert.match(doc, /\*\*for this round\*\*/)
}

// ── the file on disk, and what happens to it ──
{
  const { path: p, bytes } = writeReviewHistory('RV', '# hello\n')
  assert.ok(existsSync(p))
  assert.ok(bytes > 0)
  assert.ok(!p.includes('worktree'), 'never inside a worktree: the agent judges the checkout with git')
  assert.equal(path.dirname(p), reviewHistoryDir('RV'))

  mkdirSync(reviewHistoryDir('ORPHAN'), { recursive: true })
  writeFileSync(path.join(reviewHistoryDir('ORPHAN'), 'review-history.md'), 'x')
  assert.equal(sweepOrphanHistories(new Set(['RV'])), 1, 'a directory no review claims is swept at startup')
  assert.ok(existsSync(p), 'the live one survives')

  removeReviewHistory('RV')
  assert.ok(!existsSync(reviewHistoryDir('RV')), 'deleting the task takes its history with it')
  assert.equal(sweepOrphanHistories(new Set()), 0, 'sweeping an empty root is a no-op')
  assert.ok(reviewHistoryRoot().startsWith(tmp), 'the root follows DB_PATH')
}

// ── did it read the thing: from the tool trace, never from self-report ──
{
  d.insert(schema.runs).values({ id: 'RUN', kind: 'review', subkind: 'recheck', provider: 'claude', status: 'done', createdAt: now, updatedAt: now } as any).run()
  assert.equal(historyWasRead(d, schema, 'RUN'), false)
  d.insert(schema.runEvents).values({ id: nanoid(), runId: 'RUN', seq: 1, ts: now, kind: 'tool_result', data: JSON.stringify({ output: 'cannot open review-history.md' }) } as any).run()
  assert.equal(historyWasRead(d, schema, 'RUN'), false, 'a failed open mentions the path too — that is not having read it')
  d.insert(schema.runEvents).values({ id: nanoid(), runId: 'RUN', seq: 2, ts: now, kind: 'tool_use', data: JSON.stringify({ name: 'Read', input: { file_path: '/x/review-history.md' } }) } as any).run()
  assert.equal(historyWasRead(d, schema, 'RUN'), true)
}

rmSync(tmp, { recursive: true, force: true })
console.log('review-history: ok')

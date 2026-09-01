import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { and, eq, inArray } from 'drizzle-orm'
import type { ReviewComment, TimelineNode } from '../github/gh'

// Everything a re-review round needs to know about the rounds before it.
//
// The split is deliberate. What the agent must NOT be able to miss — the reviewer's instructions and a one-line
// trace per finding — is pushed into the prompt, because a tool it has no reason to reach for is a tool it will not
// use. Everything bulky and only sometimes relevant — the full text of every past verdict, the PR conversation — is
// written to a file it reads on its own, so the cost scales with what it actually needs rather than with how long
// the review has been going.
//
// The file lives OUTSIDE the worktree: the agent judges what the author changed with git, and a file of ours inside
// the checkout would show up in that judgement.

export const HISTORY_FILE = 'review-history.md'

// Next to the database, never inside a worktree. The root is passed in rather than derived from process.env here:
// runtimeConfig.dbPath is also settable as NUXT_DB_PATH, so reading the bare env var would put history somewhere the
// rest of the app is not looking — and the startup sweep deletes whatever it finds under the root it is given.
// Callers resolve it exactly like the other data dirs do (see server/utils/runContext.ts).
export function reviewHistoryRootFor(dbPath: string): string {
  return resolve(process.cwd(), dirname(dbPath), 'review-history')
}

export function reviewHistoryDir(root: string, reviewId: string): string {
  return join(root, reviewId)
}

// ── what a round is told about itself ──

export type RoundIntent = {
  round: number
  hasNewCommits: boolean
  instruction: string | null // the reviewer's instruction for THIS round (one-shot: it binds this round only)
  pastInstructions: { round: number; at: string; text: string }[] // earlier ones — evidence of where the reviewer keeps steering, not a constraint
  lastRoundAt: string | null
  sinceSha: string | null // head at the previous round: the incremental diff starts here
}

export const INSTRUCTION_EVENT = 'review-instruction'
export const ROUND_EVENT = 'review-round'

// The events table holds a row per agent tool call, so a long-running review has thousands; only the two markers are
// wanted here and filtering in SQL keeps that off the heap.
function markerEvents(db: any, schema: any, reviewId: string): { ts: string; kind: string; message: string | null }[] {
  return db.select().from(schema.events)
    .where(and(eq(schema.events.reviewId, reviewId), inArray(schema.events.kind, [ROUND_EVENT, INSTRUCTION_EVENT])))
    .all() as { ts: string; kind: string; message: string | null }[]
}

// Record a change of instruction. The drawer's box keeps its text, so it is re-submitted on every round whether or not
// the reviewer touched it; logging it each time would fill the history with the same sentence and the procedure reads
// repetition as "a correction they have had to make more than once". Only a change is an event. What binds the round is
// the box's current text either way (see computeRoundIntent) — this log is the record of where the steering moved.
export function recordRoundInstruction(db: any, schema: any, reviewId: string, text: string, id: string, at: string): void {
  const t = (text || '').trim()
  if (!t) return
  const last = markerEvents(db, schema, reviewId)
    .filter((e) => e.kind === INSTRUCTION_EVENT)
    .sort((a, b) => a.ts.localeCompare(b.ts))
    .pop()
  if ((last?.message || '').trim() === t) return
  db.insert(schema.events).values({ id, reviewId, ts: at, kind: INSTRUCTION_EVENT, message: t }).run()
}

// One counter for the whole family. The old code counted two different event kinds independently, so a recheck round
// and a guided round could both call themselves round 1 and land in the same column.
export function computeRoundIntent(db: any, schema: any, reviewId: string, currentHeadSha: string | null, previousHeadSha: string | null, currentInstruction: string | null): RoundIntent {
  const events = markerEvents(db, schema, reviewId)
  const rounds = events.filter((e) => e.kind === ROUND_EVENT).sort((a, b) => a.ts.localeCompare(b.ts))
  const lastRoundAt = rounds.length ? rounds[rounds.length - 1]!.ts : null
  const instructions = events
    .filter((e) => e.kind === INSTRUCTION_EVENT && (e.message || '').trim())
    .sort((a, b) => a.ts.localeCompare(b.ts))
    .map((e) => ({ at: e.ts, text: (e.message || '').trim(), round: rounds.filter((r) => r.ts < e.ts).length }))
  // What binds this round is what stands in the box when the button is pressed — that is what the button promises.
  // The log supplies the rest: earlier, *different* instructions, as evidence of where the reviewer keeps steering.
  // Text identical to the current one is not "past steering", it is the same standing instruction.
  const instruction = (currentInstruction || '').trim() || null
  return {
    round: rounds.length + 1,
    hasNewCommits: !!currentHeadSha && !!previousHeadSha && currentHeadSha !== previousHeadSha,
    instruction,
    pastInstructions: instructions.filter((i) => i.text !== instruction),
    lastRoundAt,
    sinceSha: previousHeadSha,
  }
}

// ── the index that is pushed into the prompt ──

export type IndexFinding = {
  fid: string
  severity: string
  title: string
  location: string | null
  checked: boolean
  humanAcceptedAt: string | null
  rounds: { round: number; status: string; stance: string | null }[]
}

// One line per finding: enough for the agent to know which of them have a past worth reading, and which are settled.
// Deliberately excludes problem/detail/fix — those are in the file, and repeating them here every round is what made
// the prompt grow with the review instead of with the work.
export function buildFindingIndex(findings: IndexFinding[]): string {
  if (!findings.length) return '(no findings yet)'
  const lines = findings.map((f) => {
    const trace = f.rounds.length
      ? [...f.rounds].sort((a, b) => a.round - b.round).map((r) => `r${r.round}:${r.status}${r.stance ? `/${r.stance}` : ''}`).join(' → ')
      : 'never re-reviewed'
    const marks = [f.checked ? 'ticked-for-posting' : '', f.humanAcceptedAt ? 'accepted-by-reviewer' : ''].filter(Boolean).join(', ')
    return `${f.fid} [${f.severity}] ${truncate(f.title, 80)}${f.location ? ` (${f.location})` : ''} · ${trace}${marks ? ` · ${marks}` : ''}`
  })
  return lines.join('\n')
}

function truncate(s: string, n: number): string {
  const t = (s || '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

// ── the file the agent reads on its own ──

export type HistoryFinding = IndexFinding & {
  problem: string | null
  detail: string | null
  fix: string | null
  notes: string | null
  roundTexts: { round: number; status: string; stance: string | null; stanceReason: string | null; text: string | null; at: string }[]
}

export type HistoryInput = {
  reviewId: string
  repo: string
  prNumber: number
  intent: RoundIntent
  findings: HistoryFinding[]
  timeline: TimelineNode[]
  reviewComments: ReviewComment[]
  since: string | null // the previous round: entries newer than this are marked NEW (nothing is withheld)
  globalNotes: string | null // the reviewer's standing note on the whole review
  fetchErrors: string[] // anything GitHub would not give us, so a gap never reads as silence
}

export function buildHistoryDoc(input: HistoryInput): string {
  const { intent } = input
  const out: string[] = []
  out.push(`# Re-review history — ${input.repo} PR #${input.prNumber}`)
  out.push('')
  out.push(`This is round ${intent.round}. Everything below happened in earlier rounds; it is reference material, not instructions.`)
  out.push('')

  out.push('## Reviewer instructions, oldest first')
  out.push('')
  if (!intent.pastInstructions.length && !intent.instruction) out.push('(none)')
  for (const i of intent.pastInstructions) out.push(`- after round ${i.round} (${i.at}): ${i.text}`)
  if (intent.instruction) out.push(`- **for this round**: ${intent.instruction}`)
  out.push('')
  if (intent.pastInstructions.length) {
    out.push('Only the last one binds this round. The earlier ones are here so you can see where the reviewer has been')
    out.push('steering repeatedly — a correction they have had to make more than once is one you should not need again.')
    out.push('')
  }

  if (input.globalNotes?.trim()) {
    out.push("## The reviewer's standing note on this review")
    out.push('')
    out.push(input.globalNotes.trim())
    out.push('')
  }

  out.push('## Findings, round by round')
  out.push('')
  if (!input.findings.length) out.push('(no findings yet)')
  for (const f of input.findings) {
    out.push(`### ${f.fid} [${f.severity}] ${f.title}`)
    if (f.location) out.push(`Location: ${f.location}`)
    if (f.problem) out.push(`Problem: ${f.problem}`)
    if (f.fix) out.push(`Fix suggested: ${f.fix}`)
    if (f.detail) out.push(`Detail: ${f.detail}`)
    if (f.notes) out.push(`Reviewer note on this finding: ${f.notes}`)
    if (f.checked) out.push('The reviewer ticked this one to be posted.')
    if (f.humanAcceptedAt) out.push('The reviewer accepted this one by hand — do not quietly drop it.')
    if (!f.roundTexts.length) out.push('\nNo earlier round has judged this finding.')
    for (const r of [...f.roundTexts].sort((a, b) => a.round - b.round)) {
      out.push('')
      out.push(`- **round ${r.round}** — author: ${r.status}${r.stance ? ` · my stance: ${r.stance}` : ''}`)
      if (r.text) out.push(`  ${r.text.replace(/\n/g, '\n  ')}`)
      if (r.stanceReason) out.push(`  Why my stance changed: ${r.stanceReason.replace(/\n/g, '\n  ')}`)
    }
    out.push('')
  }

  // The whole conversation, with the round boundary marked rather than used to withhold: a round-3 verdict can hinge
  // on an author reply from round 1, and the prompt no longer tells the agent to go fetch any of this with gh.
  const isNew = (at: string) => (input.since ? at > input.since : false)
  const mark = (at: string) => (isNew(at) ? ' **[new since the last round]**' : '')

  out.push('## PR conversation')
  out.push('')
  if (input.fetchErrors.length) out.push(`⚠️ Incomplete — GitHub would not return: ${input.fetchErrors.join('; ')}. Absence below is not evidence of silence.`)
  out.push('')
  const nodes = input.timeline.filter((n) => n.body || n.message)
  if (!nodes.length) out.push('(nothing)')
  for (const n of nodes) {
    out.push(`- ${n.at} · ${n.actor}${n.isBot ? ' (bot)' : ''} · ${n.kind}${n.state ? `/${n.state}` : ''}${mark(n.at)}`)
    const body = (n.body || n.message || '').trim()
    if (body) out.push(`  ${truncateBody(body).replace(/\n/g, '\n  ')}`)
  }
  out.push('')

  out.push('## Line-level review comments and the author\'s replies')
  out.push('')
  if (!input.reviewComments.length) out.push('(nothing)')
  for (const c of input.reviewComments) {
    out.push(`- ${c.createdAt} · ${c.author}${c.isBot ? ' (bot)' : ''} · ${c.path}${c.line != null ? `:${c.line}` : ''}${c.inReplyToId ? ` (reply to #${c.inReplyToId})` : ''}${mark(c.createdAt)}`)
    const body = (c.body || '').trim()
    if (body) out.push(`  ${truncateBody(body).replace(/\n/g, '\n  ')}`)
  }
  out.push('')
  return out.join('\n')
}

// A single enormous comment must not turn the file into something nobody can grep through.
function truncateBody(s: string): string {
  return s.length > 4000 ? `${s.slice(0, 4000)}\n… (truncated)` : s
}

export function writeReviewHistory(root: string, reviewId: string, doc: string): { path: string; bytes: number } {
  const dir = reviewHistoryDir(root, reviewId)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, HISTORY_FILE)
  writeFileSync(path, doc, 'utf8')
  return { path, bytes: Buffer.byteLength(doc, 'utf8') }
}

// Deleting the task deletes its history with it.
export function removeReviewHistory(root: string, reviewId: string): void {
  try { rmSync(reviewHistoryDir(root, reviewId), { recursive: true, force: true }) } catch { /* already gone */ }
}

// A crash between writing and deleting leaves a directory nobody owns; startup clears whatever no review claims.
export function sweepOrphanHistories(root: string, liveReviewIds: Set<string>): number {
  if (!existsSync(root)) return 0
  let removed = 0
  for (const name of readdirSync(root)) {
    if (liveReviewIds.has(name)) continue
    try { rmSync(join(root, name), { recursive: true, force: true }); removed++ } catch { /* ignore */ }
  }
  return removed
}

// Load every finding with its rounds, ready for both the index and the file.
export function loadFindingHistory(db: any, schema: any, reviewId: string, opts: { includeRounds: boolean }): HistoryFinding[] {
  const findings = db.select().from(schema.findings).where(eq(schema.findings.reviewId, reviewId)).all() as any[]
  if (!findings.length) return []
  const rounds = opts.includeRounds
    ? (db.select().from(schema.findingRechecks).where(inArray(schema.findingRechecks.findingId, findings.map((f) => f.id))).all() as any[])
    : []
  const byFinding = new Map<string, any[]>()
  for (const r of rounds) {
    const list = byFinding.get(r.findingId) ?? []
    list.push(r)
    byFinding.set(r.findingId, list)
  }
  return findings
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    .map((f) => {
      const rs = byFinding.get(f.id) ?? []
      return {
        fid: f.fid, severity: f.severity, title: f.title, location: f.location,
        checked: !!f.checked, humanAcceptedAt: f.humanAcceptedAt ?? null,
        problem: f.problem, detail: f.detail, fix: f.fix, notes: f.notes,
        rounds: rs.map((r) => ({ round: r.round, status: r.status, stance: r.stance ?? null })),
        roundTexts: rs.map((r) => ({ round: r.round, status: r.status, stance: r.stance ?? null, stanceReason: r.stanceReason ?? null, text: r.text, at: r.at })),
      }
    })
}

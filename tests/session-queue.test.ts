import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { eq } from 'drizzle-orm'
import { claudeHost } from '../core/host/claudeHost'
import { getDb, schema } from '../core/db/client'
import { submitSessionTurn, cancelQueuedTurn, queuedTurns, isRunBusy, stopRun } from '../core/runs/session'

// Messages sent while a turn runs are queued (persisted as 'queued' user turns), start one after the other when the
// running turn ends, can be withdrawn while waiting, and are dropped by Stop. The user-message uuid the host reports
// lands on the user turn (rewind anchor).
const d = getDb(':memory:')
const now = new Date().toISOString()
const wt = mkdtempSync(path.join(tmpdir(), 'pr-cockpit-queue-'))
execFileSync('git', ['init', '-q', wt])
execFileSync('git', ['-C', wt, 'commit', '--allow-empty', '-q', '-m', 'init'], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
d.insert(schema.projects).values({ id: 'P', name: 'proj', slug: 'p', repo: 'o/r', defaultBranch: 'main', localPath: wt, createdAt: now }).run()
d.insert(schema.runs).values({ id: 'Q1', kind: 'session', subkind: 'session', provider: 'claude', projectId: 'P', workspaceType: 'cwd', workspacePath: wt, claudeSessionId: 'cs', status: 'idle', createdAt: now, updatedAt: now } as any).run()

const ctx = (message: string) => ({
  db: d, schema, runId: 'Q1', message, defaults: { provider: 'claude' as const, model: 'sonnet', effort: 'low' },
  project: { id: 'P', repo: 'o/r', localPath: wt, defaultBranch: 'main' }, reposDir: path.join(wt, '.repos'), assetsDir: path.join(wt, '.assets'), lang: 'en',
})
const origEnsure = claudeHost.ensure
const origSend = claudeHost.send
;(claudeHost as any).ensure = async () => ({})
const sent: string[] = []
let release: (() => void) | null = null
;(claudeHost as any).send = async (_id: string, text: string, cb: any) => {
  sent.push(text)
  cb.onUserUuid?.(`uuid-${text}`)
  await new Promise<void>((r) => { release = r })
  return { text: `re:${text}`, sessionId: 'cs', usage: null, costUsd: null, subtype: 'success', isError: false, interrupted: false }
}
const tick = () => new Promise((r) => setTimeout(r, 20))
const turns = () => d.select().from(schema.runTurns).where(eq(schema.runTurns.runId, 'Q1')).all()

try {
  // first message runs right away
  const a = submitSessionTurn(ctx('one'))
  assert.equal(a.queued, false)
  await tick()
  assert.equal(isRunBusy('Q1'), true)
  assert.deepEqual(sent, ['one'])
  // two more while it runs → both parked, in order
  const b = submitSessionTurn(ctx('two'))
  const c = submitSessionTurn(ctx('three'))
  assert.equal(b.queued, true)
  assert.equal(c.queued, true)
  assert.deepEqual(queuedTurns('Q1'), [b.turnId, c.turnId])
  assert.deepEqual(turns().filter((t) => t.status === 'queued').map((t) => t.content), ['two', 'three'])
  // withdraw the middle one
  assert.equal(cancelQueuedTurn('Q1', b.turnId!, d, schema), true)
  assert.equal(cancelQueuedTurn('Q1', b.turnId!, d, schema), false)
  assert.deepEqual(queuedTurns('Q1'), [c.turnId])
  // the running turn ends → 'three' starts on its own, its user row reused (done) and the uuid recorded
  release!()
  await tick()
  assert.deepEqual(sent, ['one', 'three'])
  const three = turns().find((t) => t.id === c.turnId)!
  assert.equal(three.status, 'done')
  assert.equal(three.messageUuid, 'uuid-three')
  assert.equal(turns().find((t) => t.content === 'one')!.messageUuid, 'uuid-one')
  assert.equal(queuedTurns('Q1').length, 0)
  // Stop while a turn runs drops what is queued behind it
  const e = submitSessionTurn(ctx('four'))
  assert.equal(e.queued, true)
  stopRun('Q1', { db: d, schema })
  assert.equal(queuedTurns('Q1').length, 0)
  assert.equal(turns().find((t) => t.id === e.turnId)!.status, 'stopped')
  release!()
  await tick()
  assert.equal(isRunBusy('Q1'), false)
  assert.deepEqual(sent, ['one', 'three']) // 'four' never ran
  console.log('session-queue: ok')
} finally {
  ;(claudeHost as any).ensure = origEnsure
  ;(claudeHost as any).send = origSend
  rmSync(wt, { recursive: true, force: true })
}

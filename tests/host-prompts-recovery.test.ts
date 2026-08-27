import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { getDb, schema } from '../core/db/client'
import { recoverHostState } from '../core/host/recover'

// After a crash, prompts parked in the dead process expire and its running runs become 'stopped'; rows created after
// the boot instant (a request racing the recovery plugin) are left alone.
const d = getDb(':memory:')
const t = (offsetMs: number) => new Date(Date.parse('2026-08-26T10:00:00.000Z') + offsetMs).toISOString()
const bootAt = t(0)
const row = (id: string, status: string, updatedAt: string) => d.insert(schema.runs).values({ id, kind: 'session', subkind: 'session', provider: 'claude', workspaceType: 'cwd', status, createdAt: updatedAt, updatedAt } as any).run()
row('dead-running', 'running', t(-60_000))
row('dead-waiting', 'awaiting_input', t(-30_000))
row('old-idle', 'idle', t(-60_000))
row('fresh-running', 'running', t(+1_000)) // started after boot → belongs to the live process
d.insert(schema.permissionRequests).values({ id: 'p-old', runId: 'dead-waiting', kind: 'tool', toolName: 'Bash', input: '{}', status: 'pending', createdAt: t(-20_000) } as any).run()
d.insert(schema.permissionRequests).values({ id: 'p-answered', runId: 'dead-waiting', kind: 'tool', toolName: 'Bash', input: '{}', status: 'allowed', createdAt: t(-20_000) } as any).run()
d.insert(schema.permissionRequests).values({ id: 'p-fresh', runId: 'fresh-running', kind: 'question', toolName: 'AskUserQuestion', input: '{}', status: 'pending', createdAt: t(+2_000) } as any).run()

const r = recoverHostState(d, schema, bootAt, t(+5_000))
assert.deepEqual(r, { expiredPrompts: 1, stoppedRuns: 2 })
const status = (id: string) => d.select().from(schema.runs).where(eq(schema.runs.id, id)).get()!.status
assert.equal(status('dead-running'), 'stopped')
assert.equal(status('dead-waiting'), 'stopped')
assert.equal(status('old-idle'), 'idle')
assert.equal(status('fresh-running'), 'running')
const pstatus = (id: string) => d.select().from(schema.permissionRequests).where(eq(schema.permissionRequests.id, id)).get()!.status
assert.equal(pstatus('p-old'), 'expired')
assert.equal(pstatus('p-answered'), 'allowed')
assert.equal(pstatus('p-fresh'), 'pending')
// idempotent
assert.deepEqual(recoverHostState(d, schema, bootAt, t(+6_000)), { expiredPrompts: 0, stoppedRuns: 0 })
console.log('host-prompts-recovery: ok')

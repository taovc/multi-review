import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { getDb, schema } from '../core/db/client'
import { migrateLegacyRuns } from '../core/runs/migrate'

// Legacy fixes / feature_tasks / global_sessions (+ turns/events) → runs / run_turns / run_events with the SAME ids,
// idempotent, and a run row that already existed for a fix keeps its usage while gaining the workspace columns.
const d = getDb(':memory:') // getDb runs the migration once on an empty DB (marker set) — clear the marker to replay after seeding
const sqlite: any = (d as any).$client
const now = new Date().toISOString()
sqlite.prepare(`DELETE FROM meta WHERE key = 'runs.migrated.v1'`).run()

d.insert(schema.projects).values({ id: 'P', name: 'proj', slug: 'p', repo: 'o/r', defaultBranch: 'main', provider: 'codex', model: 'gpt-x', createdAt: now }).run()
// fix with a pre-existing run row (phase 0/1 created it) + turns + events
d.insert(schema.fixes).values({ id: 'FX', projectId: 'P', prNumber: 7, branch: 'feat/x', status: 'ready', worktreePath: '/wt/FX', baseRef: 'main', fixHeadSha: 'aaa', lastPushSha: 'bbb', sessionId: 'claude-1', title: 'Fix title', lang: 'zh', instruction: 'do it', createdAt: now, updatedAt: now } as any).run()
d.insert(schema.runs).values({ id: 'FX', kind: 'session', subkind: 'session', provider: 'claude', status: 'running', costUsd: 1.5, inputTokens: 10, outputTokens: 5, createdAt: now, updatedAt: now } as any).run()
d.insert(schema.fixTurns).values({ id: 'FXT1', fixId: 'FX', seq: 1, role: 'user', content: 'hello', status: 'done', createdAt: now } as any).run()
d.insert(schema.fixTurns).values({ id: 'FXT2', fixId: 'FX', seq: 2, role: 'assistant', content: 'partial', status: 'streaming', createdAt: now } as any).run()
d.insert(schema.fixEvents).values({ id: 'FXE1', fixId: 'FX', ts: now, kind: 'stage', message: 'worktree ready' } as any).run()
// discarded fix must not become a run
d.insert(schema.fixes).values({ id: 'FXD', projectId: 'P', prNumber: 8, branch: 'feat/d', status: 'discarded', createdAt: now, updatedAt: now } as any).run()
// feature task without a run row
d.insert(schema.featureTasks).values({ id: 'FT', projectId: 'P', description: 'build a thing', provider: 'claude', status: 'awaiting', baseBranch: 'main', branch: 'feat/thing', worktreePath: '/wt/FT', prUrl: 'https://x/pr/1', prNumber: 1, sessionId: 's2', lang: 'en', createdAt: now, updatedAt: now } as any).run()
d.insert(schema.featureTurns).values({ id: 'FTT1', taskId: 'FT', seq: 1, role: 'user', content: 'build', status: 'done', createdAt: now } as any).run()
// global session
d.insert(schema.globalSessions).values({ id: 'GS', title: 'chat', provider: 'codex', model: 'gpt-x', cwd: '/home/me', codexSessionId: 'thread-1', status: 'idle', createdAt: now, lastUsedAt: now } as any).run()
d.insert(schema.globalTurns).values({ id: 'GST1', sessionId: 'GS', seq: 1, role: 'user', content: 'hi', status: 'done', createdAt: now } as any).run()

const r1 = migrateLegacyRuns(sqlite)
assert.equal(r1.migrated, true)

const fx = d.select().from(schema.runs).where(eq(schema.runs.id, 'FX')).get()!
assert.equal(fx.workspaceType, 'pr_worktree')
assert.equal(fx.workspacePath, '/wt/FX')
assert.equal(fx.prNumber, 7)
assert.equal(fx.branch, 'feat/x')
assert.equal(fx.claudeSessionId, 'claude-1')
assert.equal(fx.uploadState, 'ready')
assert.equal(fx.status, 'idle') // 'running' in a dead process → idle
assert.equal(fx.costUsd, 1.5) // usage of the pre-existing run row survives
assert.equal(fx.title, 'Fix title')
assert.equal(fx.description, 'do it')
assert.equal(fx.baseBranch, 'main')
assert.equal(d.select().from(schema.runs).where(eq(schema.runs.id, 'FXD')).get(), undefined)
const fxTurns = d.select().from(schema.runTurns).where(eq(schema.runTurns.runId, 'FX')).all()
assert.deepEqual(fxTurns.map((t) => [t.id, t.status]), [['FXT1', 'done'], ['FXT2', 'stopped']])
const fxEvents = d.select().from(schema.runEvents).where(eq(schema.runEvents.runId, 'FX')).all()
assert.equal(fxEvents.length, 1)
assert.equal(fxEvents[0]!.message, 'worktree ready')
assert.equal(JSON.parse(fxEvents[0]!.data!).t, 'note')

const ft = d.select().from(schema.runs).where(eq(schema.runs.id, 'FT')).get()!
assert.equal(ft.workspaceType, 'branch_worktree')
assert.equal(ft.status, 'awaiting_input')
assert.equal(ft.prUrl, 'https://x/pr/1')
assert.equal(ft.description, 'build a thing')
assert.equal(ft.projectId, 'P')
assert.equal(d.select().from(schema.runTurns).where(eq(schema.runTurns.runId, 'FT')).all().length, 1)

const gs = d.select().from(schema.runs).where(eq(schema.runs.id, 'GS')).get()!
assert.equal(gs.workspaceType, 'cwd')
assert.equal(gs.workspacePath, '/home/me')
assert.equal(gs.provider, 'codex')
assert.equal(gs.codexThreadId, 'thread-1')
assert.equal(gs.title, 'chat')

// Idempotent: a second call is a no-op.
const r2 = migrateLegacyRuns(sqlite)
assert.equal(r2.migrated, false)
assert.equal(d.select().from(schema.runTurns).all().length, 4) // FXT1, FXT2, FTT1, GST1
console.log('runs-migration: ok')

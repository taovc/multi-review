import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { eq } from 'drizzle-orm'
import { claudeHost } from '../core/host/claudeHost'
import { getDb, schema } from '../core/db/client'
import { runSessionTurn, isRunBusy, fixStatusOf, hasAskBlock } from '../core/runs/session'

// The unified session turn against an in-memory DB and a stubbed host: a failed turn leaves the run in 'error' with the
// assistant turn closed as 'error'; a successful pr_worktree turn records usage and the upload state; a stop lands as
// 'stopped'. No real agent, no network (the worktree is a throwaway git repo that already exists on disk).
const d = getDb(':memory:')
const now = new Date().toISOString()
const wt = mkdtempSync(path.join(tmpdir(), 'pr-cockpit-session-'))
execFileSync('git', ['init', '-q', wt])
execFileSync('git', ['-C', wt, 'commit', '--allow-empty', '-q', '-m', 'init'], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })

d.insert(schema.projects).values({ id: 'P', name: 'proj', slug: 'p', repo: 'o/r', defaultBranch: 'main', localPath: wt, createdAt: now }).run()
d.insert(schema.runs).values({ id: 'R1', kind: 'session', subkind: 'session', provider: 'claude', projectId: 'P', workspaceType: 'pr_worktree', workspacePath: wt, prNumber: 34, branch: 'feature-branch', baseBranch: 'main', claudeSessionId: 'claude-session', status: 'idle', createdAt: now, updatedAt: now } as any).run()

const baseCtx = {
  db: d, schema, runId: 'R1', defaults: { provider: 'claude' as const, model: 'sonnet', effort: 'low' },
  project: { id: 'P', repo: 'o/r', localPath: wt, defaultBranch: 'main' }, reposDir: path.join(wt, '.repos'), assetsDir: path.join(wt, '.assets'), lang: 'en',
}
const ensureCalls: any[] = []
const origEnsure = claudeHost.ensure
const origSend = claudeHost.send
;(claudeHost as any).ensure = async (spec: any) => { ensureCalls.push(spec); return {} }

try {
  // 1) error: the host reports a failed turn
  ;(claudeHost as any).send = async () => ({ text: '', sessionId: 'claude-session', usage: null, costUsd: null, subtype: 'error_during_execution', isError: true, interrupted: false, error: 'boom' })
  await runSessionTurn({ ...baseCtx, message: 'do it' })
  let run = d.select().from(schema.runs).where(eq(schema.runs.id, 'R1')).get()!
  assert.equal(run.status, 'error')
  assert.match(run.error || '', /boom/)
  let turns = d.select().from(schema.runTurns).where(eq(schema.runTurns.runId, 'R1')).all()
  assert.equal(turns.length, 2)
  assert.equal(turns[1]!.status, 'error')
  assert.equal(isRunBusy('R1'), false)
  assert.equal(ensureCalls[0].guardScope, 'fix')
  assert.equal(ensureCalls[0].permissionMode, 'bypassPermissions')
  assert.equal(ensureCalls[0].resume, 'claude-session') // pinned provider resumes its own session

  // 2) success with usage → idle, usage recorded, upload state derived from the (clean) worktree
  ;(claudeHost as any).send = async (_id: string, _text: string, cb: any) => { cb.onText?.('hel'); cb.onText?.('lo'); return { text: 'hello', sessionId: 'claude-session', usage: { models: [{ model: 'sonnet', inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheCreateTokens: 0, costUsd: 0.01, costSource: 'reported' }], costUsd: 0.01, costSource: 'reported' }, costUsd: 0.01, subtype: 'success', isError: false, interrupted: false } }
  await runSessionTurn({ ...baseCtx, message: 'again' })
  run = d.select().from(schema.runs).where(eq(schema.runs.id, 'R1')).get()!
  assert.equal(run.status, 'idle')
  assert.equal(run.error, null)
  assert.equal(run.costUsd, 0.01)
  assert.equal(run.uploadState, 'none')
  assert.equal(fixStatusOf(run), 'open')
  turns = d.select().from(schema.runTurns).where(eq(schema.runTurns.runId, 'R1')).all()
  assert.equal(turns[3]!.content, 'hello')
  assert.equal(turns[3]!.status, 'done')

  // 3) interrupted → stopped
  ;(claudeHost as any).send = async () => ({ text: 'partial', sessionId: 'claude-session', usage: null, costUsd: null, subtype: 'interrupted', isError: false, interrupted: true })
  await runSessionTurn({ ...baseCtx, message: 'stop me' })
  run = d.select().from(schema.runs).where(eq(schema.runs.id, 'R1')).get()!
  assert.equal(run.status, 'stopped')
  turns = d.select().from(schema.runTurns).where(eq(schema.runTurns.runId, 'R1')).all()
  assert.equal(turns[5]!.status, 'stopped')

  // 4) branch_worktree: an ask-user block parks the run in awaiting_input
  d.insert(schema.runs).values({ id: 'R2', kind: 'session', subkind: 'session', provider: 'claude', projectId: 'P', workspaceType: 'branch_worktree', workspacePath: wt, branch: 'feat/x', baseBranch: 'main', claudeSessionId: 's2', status: 'idle', createdAt: now, updatedAt: now } as any).run()
  ;(claudeHost as any).send = async () => ({ text: 'Which one?\n```ask-user\nPick\n- A\n- B\n```', sessionId: 's2', usage: null, costUsd: null, subtype: 'success', isError: false, interrupted: false })
  await runSessionTurn({ ...baseCtx, runId: 'R2', message: 'build', defaults: { provider: 'claude', model: 'sonnet', translateModel: undefined } })
  run = d.select().from(schema.runs).where(eq(schema.runs.id, 'R2')).get()!
  assert.equal(run.status, 'awaiting_input')
  assert.equal(hasAskBlock('```ask-user\n'), true)
  assert.equal(ensureCalls[ensureCalls.length - 1].guardScope, 'feature')
  console.log('session-turn-error-state: ok')
} finally {
  ;(claudeHost as any).ensure = origEnsure
  ;(claudeHost as any).send = origSend
  rmSync(wt, { recursive: true, force: true })
}

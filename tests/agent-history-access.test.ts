import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDb, schema } from '../core/db/client'
import { appendTurns } from '../core/db/turns'
import {
  buildAgentHistoryMarkdown,
  prepareAgentHistoryAccess,
  registerAgentHistoryToken,
  validateAgentHistoryToken,
} from '../core/agent/historyAccess'

// The cross-provider handoff renders a session run's context + turns as markdown behind a per-run token.
const db = getDb(':memory:')
const cwd = mkdtempSync(join(tmpdir(), 'agent-history-'))
const now = new Date().toISOString()

try {
  db.insert(schema.runs).values({
    id: 'run-1', kind: 'session', subkind: 'session', provider: 'claude', projectId: null, workspaceType: 'pr_worktree', workspacePath: cwd,
    prNumber: 42, branch: 'feature/test', baseBranch: 'main', claudeSessionId: 'claude-session', status: 'idle', uploadState: 'ready', createdAt: now, updatedAt: now,
  } as any).run()

  const appended = appendTurns({ db, turnTable: schema.runTurns, fkField: 'runId', fkValue: 'run-1', now: () => now, message: 'user asked Claude to change labels' })
  db.update(schema.runTurns).set({ content: 'Claude changed label copy.', status: 'done' }).where(eq(schema.runTurns.id, appended.assistantId)).run()

  const markdown = await buildAgentHistoryMarkdown({ db, schema, id: 'run-1', cwd })
  assert.match(markdown, /Scope: PR fix session/)
  assert.match(markdown, /PR: #42/)
  assert.match(markdown, /Branch: feature\/test/)
  assert.match(markdown, /Claude session: present/)
  assert.match(markdown, /user asked Claude/)
  assert.match(markdown, /Claude changed label copy/)

  const token = registerAgentHistoryToken('run-1', 60_000)
  assert.equal(validateAgentHistoryToken('run-1', token), true)
  assert.equal(validateAgentHistoryToken('run-2', token), false)
  assert.equal(validateAgentHistoryToken('run-1', 'nope'), false)

  const access = await prepareAgentHistoryAccess({ db, schema, id: 'run-1', cwd })
  assert.match(access, /Controlled previous-conversation history/)
  assert.match(access, /\/api\/agent\/history\/run\/run-1\?token=/)

  await assert.rejects(buildAgentHistoryMarkdown({ db, schema, id: 'missing', cwd }), /history target not found/)
  console.log('agent-history-access: ok')
} finally {
  rmSync(cwd, { recursive: true, force: true })
}

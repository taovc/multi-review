import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { eq } from 'drizzle-orm'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as schema from '../core/db/schema'
import { appendTurns } from '../core/db/turns'
import {
  buildAgentHistoryMarkdown,
  prepareAgentHistoryAccess,
  registerAgentHistoryToken,
  validateAgentHistoryToken,
} from '../core/agent/historyAccess'

const sqlite = new Database(':memory:')
sqlite.exec(`
  CREATE TABLE fixes (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    branch TEXT NOT NULL,
    pr_author TEXT,
    title TEXT,
    instruction TEXT,
    lang TEXT NOT NULL DEFAULT 'en',
    status TEXT NOT NULL DEFAULT 'open',
    stage TEXT,
    summary TEXT,
    worktree_path TEXT,
    base_ref TEXT,
    base_head_sha TEXT,
    fix_head_sha TEXT,
    last_push_sha TEXT,
    last_action_kind TEXT,
    reviews_at_push INTEGER,
    files_changed INTEGER,
    additions INTEGER,
    deletions INTEGER,
    session_id TEXT,
    codex_session_id TEXT,
    last_upload_at TEXT,
    cost_usd REAL,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    pushed_at TEXT
  );
  CREATE TABLE fix_turns (
    id TEXT PRIMARY KEY,
    fix_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'done',
    created_at TEXT NOT NULL
  );
  CREATE TABLE fix_events (
    id TEXT PRIMARY KEY,
    fix_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    kind TEXT NOT NULL,
    message TEXT
  );
`)
const db = drizzle(sqlite, { schema })
const cwd = mkdtempSync(join(tmpdir(), 'agent-history-'))

try {
  db.insert(schema.fixes).values({
    id: 'fix-1',
    projectId: 'project-1',
    prNumber: 42,
    branch: 'feature/test',
    status: 'ready',
    worktreePath: cwd,
    baseHeadSha: 'base',
    sessionId: 'claude-session',
    codexSessionId: null,
    error: null,
    createdAt: 't0',
    updatedAt: 't0',
  } as any).run()

  const appended = appendTurns({ db, turnTable: schema.fixTurns, fkField: 'fixId', fkValue: 'fix-1', now: () => 't1', message: 'user asked Claude to change labels' })
  db.update(schema.fixTurns).set({ content: 'Claude changed label copy.', status: 'done' }).where(eq(schema.fixTurns.id, appended.assistantId)).run()

  const markdown = await buildAgentHistoryMarkdown({ db, schema, scope: 'fix', id: 'fix-1', cwd })
  assert.match(markdown, /Scope: fix/)
  assert.match(markdown, /PR: #42/)
  assert.match(markdown, /user asked Claude/)
  assert.match(markdown, /Claude changed label copy/)

  const token = registerAgentHistoryToken('fix', 'fix-1', 60_000)
  assert.equal(validateAgentHistoryToken('fix', 'fix-1', token), true)
  assert.equal(validateAgentHistoryToken('feature', 'fix-1', token), false)

  const access = await prepareAgentHistoryAccess({ db, schema, scope: 'fix', id: 'fix-1', cwd })
  assert.match(access, /Controlled previous-conversation history/)
  assert.match(access, /\/api\/agent\/history\/fix\/fix-1/)
  const snapshot = join(cwd, '.pr-cockpit-history.md')
  assert.equal(existsSync(snapshot), false)
} finally {
  rmSync(cwd, { recursive: true, force: true })
}

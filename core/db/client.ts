import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import * as schema from './schema'

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null

export function getDb(dbPath: string) {
  if (_db) return _db

  const dir = dirname(dbPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const sqlite = new Database(dbPath)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')

  _db = drizzle(sqlite, { schema })

  // MVP: create the tables with CREATE TABLE IF NOT EXISTS, no formal migrations
  ensureSchema(sqlite)
  ensureColumns(sqlite)
  return _db
}

// Add missing columns to existing old tables (CREATE IF NOT EXISTS won't alter a table that already exists)
function ensureColumns(sqlite: Database.Database) {
  const adds: Array<[string, string, string]> = [
    ['reviews', 'author', 'TEXT'],
    ['reviews', 'review_instruction', 'TEXT'],
    ['projects', 'active_skill_id', 'TEXT'],
    ['projects', 'provider', "TEXT NOT NULL DEFAULT 'claude'"],
    ['projects', 'model', 'TEXT'],
    ['projects', 'effort', 'TEXT'],
    ['projects', 'codex_service_tier', 'TEXT'],
    ['projects', 'auto_max_rounds', 'INTEGER NOT NULL DEFAULT 2'],
    ['projects', 'auto_cooldown_minutes', 'INTEGER NOT NULL DEFAULT 5'],
    ['pr_automation', 'head_seen_sha', 'TEXT'],
    ['pr_automation', 'head_seen_at', 'TEXT'],
    ['reviews', 'preview_json', 'TEXT'],
    ['reviews', 'preview_sig', 'TEXT'],
    ['reviews', 'author_updated', 'INTEGER NOT NULL DEFAULT 0'],
    ['reviews', 'review_decision', 'TEXT'],
    // fixes: old tables were created with CREATE IF NOT EXISTS — add the columns M1 missed + the ones M2 added
    ['fixes', 'pr_author', 'TEXT'],
    ['fixes', 'title', 'TEXT'],
    ['fixes', 'instruction', 'TEXT'],
    ['fixes', 'lang', "TEXT NOT NULL DEFAULT 'en'"],
    ['fixes', 'summary', 'TEXT'],
    ['fixes', 'session_id', 'TEXT'],
    ['fixes', 'codex_session_id', 'TEXT'],
    ['fixes', 'last_upload_at', 'TEXT'],
    ['fixes', 'base_ref', 'TEXT'],
    ['fixes', 'last_push_sha', 'TEXT'],
    ['fixes', 'last_action_kind', 'TEXT'],
    ['fixes', 'reviews_at_push', 'INTEGER'],
    // the assistant (global) stores effort per session (symmetric with model/provider); add the column to old DBs
    ['global_sessions', 'effort', 'TEXT'],
  ]
  for (const [table, col, type] of adds) {
    const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    if (!cols.some((c) => c.name === col)) {
      sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`)
    }
  }
  // Existing pushed tasks: backfill last_push_sha = fix_head_sha (treat them as uploaded so the refactor doesn't wrongly show "upload changes")
  try {
    sqlite.exec(`UPDATE fixes SET last_push_sha = fix_head_sha, last_action_kind = 'pushed'
                 WHERE pushed_at IS NOT NULL AND last_push_sha IS NULL AND fix_head_sha IS NOT NULL`)
  } catch { /* ignore when an old DB lacks those columns */ }
  // Chat-only version: normalize legacy statuses onto the new enum (old DBs may hold queued/validating/awaiting/fixing/ready/merging/conflict).
  // After the first normalization the old values are gone, so every later startup is a no-op.
  try {
    // First mark merging/conflict (which may have left a half-finished merge) as error to warn the user; any other legacy value outside the new enum falls back to open.
    sqlite.exec(`UPDATE fixes SET status = 'error' WHERE status IN ('merging','conflict')`)
    sqlite.exec(`UPDATE fixes SET status = 'open'  WHERE status NOT IN ('open','ready','pushing','pushed','error','discarded')`)
  } catch { /* ignore */ }
  // feature single-phase: normalize the two-phase legacy statuses onto the new enum. First preserve rows that already opened a PR
  // (old built + pr_url also counts as opened), then map the remaining legacy statuses (analyzing/planned/building/built) to working; opened/error are left alone.
  try {
    sqlite.exec(`UPDATE feature_tasks SET status = 'opened' WHERE pr_url IS NOT NULL AND status NOT IN ('working','awaiting','opened','error')`)
    sqlite.exec(`UPDATE feature_tasks SET status = 'working' WHERE status NOT IN ('working','awaiting','opened','error')`)
  } catch { /* ignore when an old DB lacks that table */ }
}

function ensureSchema(sqlite: Database.Database) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      repo TEXT NOT NULL,
      local_path TEXT,
      methodology_ref TEXT,
      methodology_md TEXT,
      active_skill_id TEXT,
      provider TEXT NOT NULL DEFAULT 'claude',
      model TEXT,
      effort TEXT,
      codex_service_tier TEXT,
      auto_max_rounds INTEGER NOT NULL DEFAULT 2,
      auto_cooldown_minutes INTEGER NOT NULL DEFAULT 5,
      default_branch TEXT NOT NULL DEFAULT 'dev',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS skills_project_idx ON skills(project_id);

    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      pr_number INTEGER NOT NULL,
      pr_url TEXT NOT NULL,
      title TEXT,
      author TEXT,
      branch TEXT,
      head_sha TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      pr_state TEXT NOT NULL DEFAULT 'unknown',
      additions INTEGER,
      deletions INTEGER,
      changed_files INTEGER,
      logic TEXT, quality TEXT, risk TEXT, conclusion TEXT,
      requirement TEXT, test_path TEXT, global_notes TEXT, review_instruction TEXT,
      last_post_sha TEXT,
      last_post_url TEXT,
      author_updated INTEGER NOT NULL DEFAULT 0,
      review_decision TEXT,
      preview_json TEXT,
      preview_sig TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS reviews_project_idx ON reviews(project_id);
    CREATE UNIQUE INDEX IF NOT EXISTS reviews_project_pr_uq ON reviews(project_id, pr_number);

    CREATE TABLE IF NOT EXISTS findings (
      id TEXT PRIMARY KEY,
      review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
      fid TEXT NOT NULL,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      location TEXT,
      problem TEXT,
      detail TEXT,
      fix TEXT,
      introduced_by_pr INTEGER NOT NULL DEFAULT 1,
      checked INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS findings_review_idx ON findings(review_id);

    CREATE TABLE IF NOT EXISTS finding_rechecks (
      id TEXT PRIMARY KEY,
      finding_id TEXT NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
      round INTEGER NOT NULL,
      status TEXT NOT NULL,
      text TEXT,
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS rechecks_finding_idx ON finding_rechecks(finding_id);

    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY,
      review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
      round INTEGER NOT NULL,
      url TEXT,
      sha TEXT,
      mode TEXT NOT NULL,
      body TEXT,
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS posts_review_idx ON posts(review_id);

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
      ts TEXT NOT NULL,
      kind TEXT NOT NULL,
      message TEXT
    );
    CREATE INDEX IF NOT EXISTS events_review_idx ON events(review_id);

    CREATE TABLE IF NOT EXISTS fixes (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
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
    CREATE INDEX IF NOT EXISTS fixes_project_pr_idx ON fixes(project_id, pr_number);

    CREATE TABLE IF NOT EXISTS fix_turns (
      id TEXT PRIMARY KEY,
      fix_id TEXT NOT NULL REFERENCES fixes(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'done',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS fix_turns_fix_idx ON fix_turns(fix_id);

    CREATE TABLE IF NOT EXISTS fix_events (
      id TEXT PRIMARY KEY,
      fix_id TEXT NOT NULL REFERENCES fixes(id) ON DELETE CASCADE,
      ts TEXT NOT NULL,
      kind TEXT NOT NULL,
      message TEXT
    );
    CREATE INDEX IF NOT EXISTS fix_events_fix_idx ON fix_events(fix_id);

    CREATE TABLE IF NOT EXISTS global_sessions (
      id TEXT PRIMARY KEY,
      title TEXT,
      provider TEXT NOT NULL DEFAULT 'claude',
      model TEXT,
      effort TEXT,
      cwd TEXT,
      session_id TEXT,
      codex_session_id TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      error TEXT,
      created_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS global_sessions_last_used_idx ON global_sessions(last_used_at);

    CREATE TABLE IF NOT EXISTS global_turns (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES global_sessions(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'done',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS global_turns_session_idx ON global_turns(session_id);

    CREATE TABLE IF NOT EXISTS feature_tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT,
      description TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'claude',
      model TEXT,
      lang TEXT NOT NULL DEFAULT 'en',
      status TEXT NOT NULL DEFAULT 'working',
      plan_json TEXT,
      decisions TEXT,
      base_branch TEXT,
      branch TEXT,
      worktree_path TEXT,
      base_head_sha TEXT,
      pr_number INTEGER,
      pr_url TEXT,
      session_id TEXT,
      codex_session_id TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS feature_tasks_project_idx ON feature_tasks(project_id);

    CREATE TABLE IF NOT EXISTS feature_turns (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES feature_tasks(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'done',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS feature_turns_task_idx ON feature_turns(task_id);

    CREATE TABLE IF NOT EXISTS feature_events (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES feature_tasks(id) ON DELETE CASCADE,
      ts TEXT NOT NULL,
      kind TEXT NOT NULL,
      message TEXT
    );
    CREATE INDEX IF NOT EXISTS feature_events_task_idx ON feature_events(task_id);

    CREATE TABLE IF NOT EXISTS project_automation (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      master_enabled INTEGER NOT NULL DEFAULT 0,
      review_enabled INTEGER NOT NULL DEFAULT 0,
      review_mode TEXT NOT NULL DEFAULT 'once',
      review_authors TEXT NOT NULL DEFAULT '[]',
      review_statuses TEXT NOT NULL DEFAULT '["open"]',
      fix_enabled INTEGER NOT NULL DEFAULT 0,
      fix_authors TEXT NOT NULL DEFAULT '[]',
      fix_statuses TEXT NOT NULL DEFAULT '["open"]',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pr_automation (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      pr_number INTEGER NOT NULL,
      review_on INTEGER,
      fix_on INTEGER,
      round INTEGER NOT NULL DEFAULT 0,
      last_fix_review_sha TEXT,
      pending_fix INTEGER NOT NULL DEFAULT 0,
      opt_out INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      head_seen_sha TEXT,
      head_seen_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS pr_automation_project_idx ON pr_automation(project_id);
    CREATE UNIQUE INDEX IF NOT EXISTS pr_automation_project_pr_uq ON pr_automation(project_id, pr_number);

    CREATE TABLE IF NOT EXISTS automation_events (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      pr_number INTEGER NOT NULL,
      ts TEXT NOT NULL,
      kind TEXT NOT NULL,
      message TEXT
    );
    CREATE INDEX IF NOT EXISTS automation_events_pr_idx ON automation_events(project_id, pr_number);
  `)
}

export { schema }

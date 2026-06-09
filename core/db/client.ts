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

  // MVP：用 CREATE TABLE IF NOT EXISTS 自建表，不跑正式 migration
  ensureSchema(sqlite)
  ensureColumns(sqlite)
  return _db
}

// 给已存在的旧表补列（CREATE IF NOT EXISTS 不会改已有表）
function ensureColumns(sqlite: Database.Database) {
  const adds: Array<[string, string, string]> = [
    ['reviews', 'author', 'TEXT'],
    ['reviews', 'review_instruction', 'TEXT'],
    ['projects', 'active_skill_id', 'TEXT'],
    ['projects', 'model', 'TEXT'],
    ['projects', 'effort', 'TEXT'],
    ['reviews', 'preview_json', 'TEXT'],
    ['reviews', 'preview_sig', 'TEXT'],
    ['reviews', 'author_updated', 'INTEGER NOT NULL DEFAULT 0'],
    ['reviews', 'review_decision', 'TEXT'],
  ]
  for (const [table, col, type] of adds) {
    const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    if (!cols.some((c) => c.name === col)) {
      sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`)
    }
  }
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
      model TEXT,
      effort TEXT,
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
      steps TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      stage TEXT,
      worktree_path TEXT,
      base_head_sha TEXT,
      fix_head_sha TEXT,
      files_changed INTEGER,
      additions INTEGER,
      deletions INTEGER,
      tests_result TEXT,
      cost_usd REAL,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      pushed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS fixes_project_pr_idx ON fixes(project_id, pr_number);
  `)
}

export { schema }

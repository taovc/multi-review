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
    ['projects', 'provider', "TEXT NOT NULL DEFAULT 'claude'"],
    ['projects', 'model', 'TEXT'],
    ['projects', 'effort', 'TEXT'],
    ['reviews', 'preview_json', 'TEXT'],
    ['reviews', 'preview_sig', 'TEXT'],
    ['reviews', 'author_updated', 'INTEGER NOT NULL DEFAULT 0'],
    ['reviews', 'review_decision', 'TEXT'],
    // fixes：旧表用 CREATE IF NOT EXISTS 建的，补 M1 漏掉的列 + M2 新增列
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
  ]
  for (const [table, col, type] of adds) {
    const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    if (!cols.some((c) => c.name === col)) {
      sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`)
    }
  }
  // 已存在的 pushed 任务：回填 last_push_sha = fix_head_sha（视作已上传，避免重构后误显示「上传改动」）
  try {
    sqlite.exec(`UPDATE fixes SET last_push_sha = fix_head_sha, last_action_kind = 'pushed'
                 WHERE pushed_at IS NOT NULL AND last_push_sha IS NULL AND fix_head_sha IS NOT NULL`)
  } catch { /* 老库无相关列时忽略 */ }
  // 纯对话版：把遗留旧状态归一到新枚举（旧库可能有 queued/validating/awaiting/fixing/ready/merging/conflict）。
  // 首次归一后旧值不再存在，之后每次启动都是空操作。
  try {
    // 先把（可能留着半截 merge 的）merging/conflict 标 error 提醒用户；其余任何不在新枚举里的旧值兜底归到 open。
    sqlite.exec(`UPDATE fixes SET status = 'error' WHERE status IN ('merging','conflict')`)
    sqlite.exec(`UPDATE fixes SET status = 'open'  WHERE status NOT IN ('open','ready','pushing','pushed','error','discarded')`)
  } catch { /* 忽略 */ }
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

    CREATE TABLE IF NOT EXISTS feature_tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT,
      description TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'claude',
      model TEXT,
      lang TEXT NOT NULL DEFAULT 'en',
      status TEXT NOT NULL DEFAULT 'analyzing',
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
  `)
}

export { schema }

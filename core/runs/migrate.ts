import type Database from 'better-sqlite3'

// One-shot migration of the legacy chat tables (fixes / feature_tasks / global_sessions + their turns and events) into
// runs / run_turns / run_events. Ids are preserved (the PR list, the drawers and automation keep working with the
// same ids). The legacy tables are left in place as a rollback safety net; no code reads them after this.
// Idempotent: guarded by a meta marker and by NOT IN checks, so a partial run can be repeated.

const MARKER = 'runs.migrated.v1'

export function migrateLegacyRuns(sqlite: Database.Database): { migrated: boolean; counts?: Record<string, number> } {
  const has = (table: string) => !!sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table)
  if (!has('meta') || !has('runs')) return { migrated: false }
  const done = sqlite.prepare(`SELECT value FROM meta WHERE key = ?`).get(MARKER)
  if (done) return { migrated: false }
  const counts: Record<string, number> = {}
  const run = (label: string, sql: string) => { counts[label] = (counts[label] ?? 0) + sqlite.prepare(sql).run().changes }

  const tx = sqlite.transaction(() => {
    if (has('fixes')) {
      // Rows that already have a run (phase 0/1 created one under the fix id) get their workspace columns filled in;
      // the rest are inserted. Discarded fixes are gone from the product's point of view.
      run('fix-update', `
        UPDATE runs SET
          workspace_type = 'pr_worktree', workspace_path = COALESCE(f.worktree_path, runs.workspace_path), pr_number = f.pr_number, branch = f.branch,
          claude_session_id = COALESCE(runs.claude_session_id, f.session_id), codex_thread_id = COALESCE(runs.codex_thread_id, f.codex_session_id),
          title = COALESCE(runs.title, f.title), lang = COALESCE(runs.lang, f.lang), description = COALESCE(runs.description, f.instruction),
          base_branch = COALESCE(runs.base_branch, f.base_ref), base_head_sha = COALESCE(runs.base_head_sha, f.base_head_sha),
          fix_head_sha = COALESCE(runs.fix_head_sha, f.fix_head_sha), last_push_sha = COALESCE(runs.last_push_sha, f.last_push_sha),
          pushed_at = COALESCE(runs.pushed_at, f.pushed_at), reviews_at_push = COALESCE(runs.reviews_at_push, f.reviews_at_push), pr_author = COALESCE(runs.pr_author, f.pr_author),
          upload_state = CASE f.status WHEN 'ready' THEN 'ready' WHEN 'pushed' THEN 'pushed' ELSE 'none' END,
          status = CASE WHEN f.status = 'error' THEN 'error' WHEN runs.status IN ('running', 'awaiting_input') THEN 'idle' ELSE runs.status END,
          error = CASE WHEN f.status = 'error' THEN f.error ELSE runs.error END
        FROM fixes f WHERE f.id = runs.id AND f.status != 'discarded'`)
      run('fix-insert', `
        INSERT INTO runs (id, kind, subkind, project_id, workspace_type, workspace_path, pr_number, branch, provider, model, effort, codex_service_tier,
          claude_session_id, codex_thread_id, status, title, lang, error, cost_usd, created_at, started_at, updated_at,
          description, base_branch, base_head_sha, fix_head_sha, last_push_sha, pushed_at, reviews_at_push, pr_author, upload_state)
        SELECT f.id, 'session', 'session', f.project_id, 'pr_worktree', f.worktree_path, f.pr_number, f.branch,
          COALESCE(p.provider, 'claude'), p.model, p.effort, p.codex_service_tier,
          f.session_id, f.codex_session_id, CASE f.status WHEN 'error' THEN 'error' ELSE 'idle' END, f.title, f.lang, f.error, f.cost_usd, f.created_at, f.created_at, f.updated_at,
          f.instruction, f.base_ref, f.base_head_sha, f.fix_head_sha, f.last_push_sha, f.pushed_at, f.reviews_at_push, f.pr_author,
          CASE f.status WHEN 'ready' THEN 'ready' WHEN 'pushed' THEN 'pushed' ELSE 'none' END
        FROM fixes f LEFT JOIN projects p ON p.id = f.project_id
        WHERE f.status != 'discarded' AND f.id NOT IN (SELECT id FROM runs)`)
      run('fix-turns', `
        INSERT INTO run_turns (id, run_id, seq, role, content, status, created_at)
        SELECT t.id, t.fix_id, t.seq, t.role, t.content, CASE t.status WHEN 'streaming' THEN 'stopped' ELSE t.status END, t.created_at
        FROM fix_turns t WHERE t.fix_id IN (SELECT id FROM runs) AND t.id NOT IN (SELECT id FROM run_turns)`)
      run('fix-events', `
        INSERT INTO run_events (id, run_id, seq, turn_id, ts, kind, message, data)
        SELECT e.id, e.fix_id, 0, NULL, e.ts, 'note', e.message, json_object('t', 'note', 'text', COALESCE(e.message, e.kind))
        FROM fix_events e WHERE e.fix_id IN (SELECT id FROM runs) AND e.message IS NOT NULL AND e.id NOT IN (SELECT id FROM run_events)`)
    }
    if (has('feature_tasks')) {
      run('feature-update', `
        UPDATE runs SET
          workspace_type = 'branch_worktree', workspace_path = COALESCE(t.worktree_path, runs.workspace_path), pr_number = COALESCE(runs.pr_number, t.pr_number), branch = COALESCE(runs.branch, t.branch),
          claude_session_id = COALESCE(runs.claude_session_id, t.session_id), codex_thread_id = COALESCE(runs.codex_thread_id, t.codex_session_id),
          title = COALESCE(runs.title, t.title), lang = COALESCE(runs.lang, t.lang), description = COALESCE(runs.description, t.description),
          base_branch = COALESCE(runs.base_branch, t.base_branch), base_head_sha = COALESCE(runs.base_head_sha, t.base_head_sha), pr_url = COALESCE(runs.pr_url, t.pr_url),
          status = CASE t.status WHEN 'error' THEN 'error' WHEN 'awaiting' THEN 'awaiting_input' ELSE (CASE WHEN runs.status IN ('running', 'awaiting_input') THEN 'idle' ELSE runs.status END) END,
          error = CASE WHEN t.status = 'error' THEN t.error ELSE runs.error END
        FROM feature_tasks t WHERE t.id = runs.id`)
      run('feature-insert', `
        INSERT INTO runs (id, kind, subkind, project_id, workspace_type, workspace_path, pr_number, branch, provider, model, effort,
          claude_session_id, codex_thread_id, status, title, lang, error, created_at, started_at, updated_at, description, base_branch, base_head_sha, pr_url)
        SELECT t.id, 'session', 'session', t.project_id, 'branch_worktree', t.worktree_path, t.pr_number, t.branch, COALESCE(t.provider, 'claude'), t.model, NULL,
          t.session_id, t.codex_session_id, CASE t.status WHEN 'error' THEN 'error' WHEN 'awaiting' THEN 'awaiting_input' ELSE 'idle' END, t.title, t.lang, t.error, t.created_at, t.created_at, t.updated_at,
          t.description, t.base_branch, t.base_head_sha, t.pr_url
        FROM feature_tasks t WHERE t.id NOT IN (SELECT id FROM runs)`)
      run('feature-turns', `
        INSERT INTO run_turns (id, run_id, seq, role, content, status, created_at)
        SELECT t.id, t.task_id, t.seq, t.role, t.content, CASE t.status WHEN 'streaming' THEN 'stopped' ELSE t.status END, t.created_at
        FROM feature_turns t WHERE t.task_id IN (SELECT id FROM runs) AND t.id NOT IN (SELECT id FROM run_turns)`)
      run('feature-events', `
        INSERT INTO run_events (id, run_id, seq, turn_id, ts, kind, message, data)
        SELECT e.id, e.task_id, 0, NULL, e.ts, 'note', e.message, json_object('t', 'note', 'text', COALESCE(e.message, e.kind))
        FROM feature_events e WHERE e.task_id IN (SELECT id FROM runs) AND e.message IS NOT NULL AND e.id NOT IN (SELECT id FROM run_events)`)
    }
    if (has('global_sessions')) {
      run('global-update', `
        UPDATE runs SET
          workspace_type = 'cwd', workspace_path = COALESCE(g.cwd, runs.workspace_path),
          claude_session_id = COALESCE(runs.claude_session_id, g.session_id), codex_thread_id = COALESCE(runs.codex_thread_id, g.codex_session_id),
          title = COALESCE(runs.title, g.title), model = COALESCE(runs.model, g.model), effort = COALESCE(runs.effort, g.effort),
          status = CASE g.status WHEN 'error' THEN 'error' ELSE (CASE WHEN runs.status IN ('running', 'awaiting_input') THEN 'idle' ELSE runs.status END) END,
          error = CASE WHEN g.status = 'error' THEN g.error ELSE runs.error END, updated_at = MAX(runs.updated_at, g.last_used_at)
        FROM global_sessions g WHERE g.id = runs.id`)
      run('global-insert', `
        INSERT INTO runs (id, kind, subkind, project_id, workspace_type, workspace_path, provider, model, effort,
          claude_session_id, codex_thread_id, status, title, error, created_at, started_at, updated_at)
        SELECT g.id, 'session', 'session', NULL, 'cwd', g.cwd, COALESCE(g.provider, 'claude'), g.model, g.effort,
          g.session_id, g.codex_session_id, CASE g.status WHEN 'error' THEN 'error' ELSE 'idle' END, g.title, g.error, g.created_at, g.created_at, g.last_used_at
        FROM global_sessions g WHERE g.id NOT IN (SELECT id FROM runs)`)
      run('global-turns', `
        INSERT INTO run_turns (id, run_id, seq, role, content, status, created_at)
        SELECT t.id, t.session_id, t.seq, t.role, t.content, CASE t.status WHEN 'streaming' THEN 'stopped' ELSE t.status END, t.created_at
        FROM global_turns t WHERE t.session_id IN (SELECT id FROM runs) AND t.id NOT IN (SELECT id FROM run_turns)`)
    }
    sqlite.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`).run(MARKER, new Date().toISOString())
  })
  tx()
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  if (total) console.log(`[runs] migrated legacy chat tables into runs: ${Object.entries(counts).filter(([, n]) => n).map(([k, n]) => `${k}=${n}`).join(' ')}`)
  return { migrated: true, counts }
}

import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core'

// Project: one repo + one methodology (review template)
export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  repo: text('repo').notNull(), // owner/repo
  localPath: text('local_path'), // reused local clone path (worktrees are created from here)
  methodologyRef: text('methodology_ref'), // legacy: methodology file path (kept for compatibility)
  methodologyMd: text('methodology_md'), // legacy: inline methodology (kept for compatibility)
  activeSkillId: text('active_skill_id'), // the review skill currently in use
  provider: text('provider', { enum: ['claude', 'codex'] }).notNull().default('claude'),
  model: text('model'), // model alias/full name used for review (empty = global default)
  effort: text('effort'), // review effort comes from the provider's model catalog; Codex may include minimal/low/medium/high/xhigh/max/ultra (empty = unset)
  codexServiceTier: text('codex_service_tier'), // Codex-only service tier; null = no override, fast = enable the fast tier
  // Per-PR round cap for the automated "fix ↔ recheck" loop (keeps a self-driving loop from burning tokens).
  // Edited in the project config, next to the model selection.
  autoMaxRounds: integer('auto_max_rounds').notNull().default(2),
  // Automation cooldown (minutes): after a PR's head is first seen, wait this long before acting,
  // giving the user time to go in and turn off the ones they don't want run. 0 = no cooldown.
  autoCooldownMinutes: integer('auto_cooldown_minutes').notNull().default(5),
  defaultBranch: text('default_branch').notNull().default('dev'),
  createdAt: text('created_at').notNull(),
})

// A project's review skills (there can be several; one is active)
export const skills = sqliteTable('skills', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  content: text('content').notNull(), // methodology body (markdown)
  source: text('source', { enum: ['manual', 'file', 'ai', 'optimized'] }).notNull().default('manual'),
  createdAt: text('created_at').notNull(),
})

// One PR review = one row
export const reviews = sqliteTable('reviews', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  prNumber: integer('pr_number').notNull(),
  prUrl: text('pr_url').notNull(),
  title: text('title'),
  author: text('author'),
  branch: text('branch'),
  headSha: text('head_sha'),
  // Review lifecycle
  status: text('status', {
    enum: [
      'queued',
      'cloning',
      'reviewing',
      'draft',
      'ready_to_post',
      'posting', // "claimed" for posting: assembling/translating/publishing all hold this status, preventing concurrent duplicate or stale posts
      'posted',
      'recheck_requested',
      'rechecking',
      'error',
    ],
  })
    .notNull()
    .default('queued'),
  // The PR's real state on GitHub
  prState: text('pr_state', { enum: ['open', 'merged', 'closed', 'draft', 'unknown'] })
    .notNull()
    .default('unknown'),
  additions: integer('additions'),
  deletions: integer('deletions'),
  changedFiles: integer('changed_files'),
  // The four review sections (drafted in one pass)
  logic: text('logic'),
  quality: text('quality'),
  risk: text('risk'),
  conclusion: text('conclusion'),
  requirement: text('requirement'),
  testPath: text('test_path'),
  globalNotes: text('global_notes'), // preamble of the posted comment
  reviewInstruction: text('review_instruction'), // review instruction for the AI (reused when re-reviewing)
  // Posting anchor: the head sha at the time of the last posted comment → compared with the current
  // head on refresh to tell whether the author pushed again
  lastPostSha: text('last_post_sha'),
  lastPostUrl: text('last_post_url'),
  // Set when a refresh finds the author pushed after your last comment → persisted, and the list/drawer
  // shows "author updated" based on it
  authorUpdated: integer('author_updated', { mode: 'boolean' }).notNull().default(false),
  // GitHub PR review decision APPROVED / CHANGES_REQUESTED / REVIEW_REQUIRED (fetched on refresh)
  // → drives the PR badge ("approved" etc.)
  reviewDecision: text('review_decision'),
  // Preview cache: the assembled English comment JSON + a signature of its inputs
  // (regenerated only when the signature changes)
  previewJson: text('preview_json'),
  previewSig: text('preview_sig'),
  error: text('error'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

// A single finding
export const findings = sqliteTable('findings', {
  id: text('id').primaryKey(),
  reviewId: text('review_id')
    .notNull()
    .references(() => reviews.id, { onDelete: 'cascade' }),
  fid: text('fid').notNull(), // F1, F2, ...
  severity: text('severity', { enum: ['High', 'Medium', 'Low'] }).notNull(),
  title: text('title').notNull(),
  location: text('location'), // path:line
  problem: text('problem'),
  detail: text('detail'),
  fix: text('fix'),
  introducedByPr: integer('introduced_by_pr', { mode: 'boolean' }).notNull().default(true),
  checked: integer('checked', { mode: 'boolean' }).notNull().default(false), // include in the PR comment
  notes: text('notes'),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: text('created_at').notNull(),
})

// Recheck entries appended per finding (multiple rounds each)
export const findingRechecks = sqliteTable('finding_rechecks', {
  id: text('id').primaryKey(),
  findingId: text('finding_id')
    .notNull()
    .references(() => findings.id, { onDelete: 'cascade' }),
  round: integer('round').notNull(),
  // Recheck (did the author fix it): fixed/partial/unaddressed/replied/new
  // Recheck with feedback (AI responding to my note): kept/retracted/adjusted/discuss/new
  status: text('status', {
    enum: ['fixed', 'partial', 'unaddressed', 'replied', 'new', 'kept', 'retracted', 'adjusted', 'discuss'],
  }).notNull(),
  text: text('text'),
  at: text('at').notNull(),
})

// Posted-comment records (multiple rounds)
export const posts = sqliteTable('posts', {
  id: text('id').primaryKey(),
  reviewId: text('review_id')
    .notNull()
    .references(() => reviews.id, { onDelete: 'cascade' }),
  round: integer('round').notNull(),
  url: text('url'),
  sha: text('sha'),
  mode: text('mode', { enum: ['review', 'comment', 'mixed'] }).notNull(),
  body: text('body'),
  at: text('at').notNull(),
})

// Event stream (progress + history, fed to SSE)
export const events = sqliteTable('events', {
  id: text('id').primaryKey(),
  reviewId: text('review_id')
    .notNull()
    .references(() => reviews.id, { onDelete: 'cascade' }),
  ts: text('ts').notNull(),
  kind: text('kind').notNull(), // queued|stage|finding|error|posted|recheck|...
  message: text('message'),
})

// One "fix PR" task (conversation-only): chat with Claude to change code inside the PR branch's
// worktree (no automatic commit); it only commits + pushes when the user clicks "commit and upload".
// There are no verify / batch-fix / merge-base-branch / reply-to-author stages.
// The worktree is created lazily on the first message and kept until push/discard.
export const fixes = sqliteTable('fixes', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  prNumber: integer('pr_number').notNull(),
  branch: text('branch').notNull(),
  prAuthor: text('pr_author'), // PR author (for display / reviewer-updated; push is no longer restricted to your own PRs)
  title: text('title'),
  instruction: text('instruction'), // targeted instruction typed in the prompt box when creating the task (empty = system default)
  lang: text('lang').notNull().default('en'), // working language = UI locale when the task was created (verdict/feedback are written in it)
  // open: created/chatting, nothing to upload; ready: the conversation changed code, there are uncommitted/unpushed changes to upload;
  // pushing: uploading; pushed: uploaded; error: failed.
  // discarded is a legacy enum value (discard now hard-deletes the row, so it is never set again).
  status: text('status', {
    enum: ['open', 'ready', 'pushing', 'pushed', 'error', 'discarded'],
  })
    .notNull()
    .default('open'),
  stage: text('stage'), // current fine-grained stage text (shown live)
  summary: text('summary'), // overall conclusion of the verify stage
  worktreePath: text('worktree_path'),
  baseRef: text('base_ref'), // the PR's target branch name (three-dot diff baseline origin/<baseRef>...HEAD + used for merge)
  baseHeadSha: text('base_head_sha'), // the PR head before the changes (diff baseline)
  fixHeadSha: text('fix_head_sha'), // the head after the local commit
  lastPushSha: text('last_push_sha'), // the last commit successfully pushed; different from fixHeadSha = there are changes not uploaded yet
  lastActionKind: text('last_action_kind', { enum: ['pushed'] }), // the most recent outward action (upload) → drives the "view changes" entry point
  reviewsAtPush: integer('reviews_at_push'), // the PR's review count when the fix was pushed; a higher count later = the reviewer reviewed again ("review updated" baseline)
  filesChanged: integer('files_changed'),
  additions: integer('additions'),
  deletions: integer('deletions'),
  sessionId: text('session_id'), // session id of the claude stream-json run (used later with --resume)
  codexSessionId: text('codex_session_id'), // codex thread id (resumeThread); stored separately from claude's, never mixed when switching provider
  lastUploadAt: text('last_upload_at'), // time of the last upload → "review updated" baseline (M3)
  costUsd: real('cost_usd'),
  error: text('error'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  pushedAt: text('pushed_at'),
})

// M2 conversation follow-up: after the fix is drafted, keep chatting and editing in the drawer
// (claude --resume continues the session).
// Append-only, ordered by seq; assistant turns are written as they stream. Both restart recovery
// and display rely on it.
export const fixTurns = sqliteTable('fix_turns', {
  id: text('id').primaryKey(),
  fixId: text('fix_id')
    .notNull()
    .references(() => fixes.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(),
  role: text('role', { enum: ['user', 'assistant'] }).notNull(),
  content: text('content').notNull().default(''),
  status: text('status', { enum: ['streaming', 'done', 'error', 'stopped'] }).notNull().default('done'),
  createdAt: text('created_at').notNull(),
})

// Progress events of a fix task (the agent's line-by-line actions while verifying/fixing/chatting).
// Structurally identical to what the events table is for reviews; it exists separately only because
// events has an FK to reviews. Persisting them lets a reopened task backfill its history log (same as
// the review drawer).
export const fixEvents = sqliteTable('fix_events', {
  id: text('id').primaryKey(),
  fixId: text('fix_id')
    .notNull()
    .references(() => fixes.id, { onDelete: 'cascade' }),
  ts: text('ts').notNull(),
  kind: text('kind').notNull(),
  message: text('message'),
})

// ── Global chatbot drawer: a free-form session independent of any PR/project
// (a bypassPermissions "can do anything" assistant).
export const globalSessions = sqliteTable('global_sessions', {
  id: text('id').primaryKey(),
  title: text('title'),
  provider: text('provider', { enum: ['claude', 'codex'] }).notNull().default('claude'),
  model: text('model'),
  effort: text('effort'),
  cwd: text('cwd'),
  sessionId: text('session_id'),
  codexSessionId: text('codex_session_id'),
  status: text('status', { enum: ['idle', 'streaming', 'error'] }).notNull().default('idle'),
  error: text('error'),
  createdAt: text('created_at').notNull(),
  lastUsedAt: text('last_used_at').notNull(),
})

export const globalTurns = sqliteTable('global_turns', {
  id: text('id').primaryKey(),
  sessionId: text('session_id')
    .notNull()
    .references(() => globalSessions.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(),
  role: text('role', { enum: ['user', 'assistant'] }).notNull(),
  content: text('content').notNull().default(''),
  status: text('status', { enum: ['streaming', 'done', 'error', 'stopped'] }).notNull().default('done'),
  createdAt: text('created_at').notNull(),
})

// ── Feature development loop.
export const featureTasks = sqliteTable('feature_tasks', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  title: text('title'),
  description: text('description').notNull(),
  provider: text('provider', { enum: ['claude', 'codex'] }).notNull().default('claude'),
  model: text('model'),
  lang: text('lang').notNull().default('en'),
  // Single-phase status: working = developing / can continue · awaiting = the agent is waiting for your
  // decision (ask-user) · opened = the PR is open · error.
  status: text('status', {
    enum: ['working', 'awaiting', 'opened', 'error'],
  })
    .notNull()
    .default('working'),
  planJson: text('plan_json'), // legacy column (the two-phase design was removed; kept so old DBs still work; never written)
  decisions: text('decisions'), // legacy column, same as above
  baseBranch: text('base_branch'),
  branch: text('branch'),
  worktreePath: text('worktree_path'),
  baseHeadSha: text('base_head_sha'),
  prNumber: integer('pr_number'),
  prUrl: text('pr_url'),
  sessionId: text('session_id'),
  codexSessionId: text('codex_session_id'),
  error: text('error'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const featureTurns = sqliteTable('feature_turns', {
  id: text('id').primaryKey(),
  taskId: text('task_id')
    .notNull()
    .references(() => featureTasks.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(),
  role: text('role', { enum: ['user', 'assistant'] }).notNull(),
  content: text('content').notNull().default(''),
  status: text('status', { enum: ['streaming', 'done', 'error', 'stopped'] }).notNull().default('done'),
  createdAt: text('created_at').notNull(),
})

export const featureEvents = sqliteTable('feature_events', {
  id: text('id').primaryKey(),
  taskId: text('task_id')
    .notNull()
    .references(() => featureTasks.id, { onDelete: 'cascade' }),
  ts: text('ts').notNull(),
  kind: text('kind').notNull(),
  message: text('message'),
})

// ── PR automation (auto review / auto fix). One project-level config + per-PR runtime state.
// The engine (the poll loop in server/plugins/automation.ts) reads these two tables + GitHub state
// and dispatches work through the existing endpoints.
// Project level: the automation config dialog is stored here (one row per project).
// authors/statuses are JSON arrays (empty array = no restriction).
export const projectAutomation = sqliteTable('project_automation', {
  projectId: text('project_id')
    .primaryKey()
    .references(() => projects.id, { onDelete: 'cascade' }),
  masterEnabled: integer('master_enabled', { mode: 'boolean' }).notNull().default(false), // the "enable the system" master switch at the bottom of the dialog
  reviewEnabled: integer('review_enabled', { mode: 'boolean' }).notNull().default(false), // auto-review system switch
  reviewMode: text('review_mode', { enum: ['once', 'every_push'] }).notNull().default('once'), // once / every push (every push = auto recheck after the author updates)
  reviewAuthors: text('review_authors').notNull().default('[]'), // JSON string[], empty = any author
  reviewStatuses: text('review_statuses').notNull().default('["open"]'), // JSON string[] (pullKey: open/draft/merged/closed), defaults to open (drafts unchecked by default)
  fixEnabled: integer('fix_enabled', { mode: 'boolean' }).notNull().default(false), // auto-fix system switch
  fixAuthors: text('fix_authors').notNull().default('[]'),
  fixStatuses: text('fix_statuses').notNull().default('["open"]'),
  updatedAt: text('updated_at').notNull(),
})

// Automation workflow timeline: what the engine did to a given PR (create review / review / post comment /
// fix / upload / recheck / cap / converge …), in chronological order.
// The PR drawer's "automation" tab renders its timeline from this. Same shape as events/fix_events, but
// keyed by (projectId, prNumber) instead of a task id, so the history survives deleting the review/fix task.
export const automationEvents = sqliteTable('automation_events', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  prNumber: integer('pr_number').notNull(),
  ts: text('ts').notNull(),
  kind: text('kind').notNull(), // review_created|recheck|posted|fix_started|pushed|capped|converged|cant_fix|fix_error
  message: text('message'),
})

// Per-PR automation runtime state + instance-level override switches (the two switches in the PR drawer).
// reviewOn/fixOn null = follow the project config (inherit); explicit 0/1 = the user overrode it on this PR.
// Deleting the review/fix task → optOut=1 (keeps the global config from reviving it on the next round).
// Turning a switch back on → clears round/note/optOut.
export const prAutomation = sqliteTable('pr_automation', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  prNumber: integer('pr_number').notNull(),
  reviewOn: integer('review_on', { mode: 'boolean' }), // null = inherit the config
  fixOn: integer('fix_on', { mode: 'boolean' }), // null = inherit the config
  round: integer('round').notNull().default(0), // how many auto fixes have been dispatched (capped at autoMaxRounds)
  lastFixReviewSha: text('last_fix_review_sha'), // which review head the last fix was dispatched for (no repeat fix for the same head)
  pendingFix: integer('pending_fix', { mode: 'boolean' }).notNull().default(false), // a fix was dispatched, waiting for it to finish (push / declared unfixable)
  optOut: integer('opt_out', { mode: 'boolean' }).notNull().default(false), // the user deleted the task → this PR leaves automation until manually re-enabled
  note: text('note'), // the engine's most recent reason for stopping: capped/converged/cant_fix/fix_error/user_off (feeds the UI hint)
  // Cooldown: the sha + time when the engine first saw this head. Reset when the head changes;
  // no action until autoCooldownMinutes has elapsed.
  headSeenSha: text('head_seen_sha'),
  headSeenAt: text('head_seen_at'),
  updatedAt: text('updated_at').notNull(),
})

export type Project = typeof projects.$inferSelect
export type Skill = typeof skills.$inferSelect
export type Review = typeof reviews.$inferSelect
export type Finding = typeof findings.$inferSelect
export type FindingRecheck = typeof findingRechecks.$inferSelect
export type Post = typeof posts.$inferSelect
export type ReviewEvent = typeof events.$inferSelect
export type Fix = typeof fixes.$inferSelect
export type FixTurn = typeof fixTurns.$inferSelect
export type FixEvent = typeof fixEvents.$inferSelect
export type GlobalSession = typeof globalSessions.$inferSelect
export type GlobalTurn = typeof globalTurns.$inferSelect
export type FeatureTask = typeof featureTasks.$inferSelect
export type FeatureTurn = typeof featureTurns.$inferSelect
export type FeatureEvent = typeof featureEvents.$inferSelect
export type ProjectAutomation = typeof projectAutomation.$inferSelect
export type PrAutomation = typeof prAutomation.$inferSelect
export type AutomationEvent = typeof automationEvents.$inferSelect

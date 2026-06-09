import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core'

// 项目：一个 repo + 一套方法学（review 模板）
export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  repo: text('repo').notNull(), // owner/repo
  localPath: text('local_path'), // 复用的本地 clone 路径（worktree 从这里开）
  methodologyRef: text('methodology_ref'), // 旧：方法学文件路径（保留兼容）
  methodologyMd: text('methodology_md'), // 旧：内联方法学（保留兼容）
  activeSkillId: text('active_skill_id'), // 当前启用的审核 skill
  model: text('model'), // 审核用模型别名/全名（空=全局默认）
  effort: text('effort'), // 审核力度 low/medium/high/xhigh/max（空=不设）
  defaultBranch: text('default_branch').notNull().default('dev'),
  createdAt: text('created_at').notNull(),
})

// 项目的审核 skill（可多份，选一份 active）
export const skills = sqliteTable('skills', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  content: text('content').notNull(), // 方法学正文（markdown）
  source: text('source', { enum: ['manual', 'file', 'ai', 'optimized'] }).notNull().default('manual'),
  createdAt: text('created_at').notNull(),
})

// 一次 PR 审核 = 一行
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
  // 审核生命周期
  status: text('status', {
    enum: [
      'queued',
      'cloning',
      'reviewing',
      'draft',
      'ready_to_post',
      'posted',
      'recheck_requested',
      'rechecking',
      'error',
    ],
  })
    .notNull()
    .default('queued'),
  // GitHub 上的 PR 真实状态
  prState: text('pr_state', { enum: ['open', 'merged', 'closed', 'draft', 'unknown'] })
    .notNull()
    .default('unknown'),
  additions: integer('additions'),
  deletions: integer('deletions'),
  changedFiles: integer('changed_files'),
  // 审核四段（一次性出稿）
  logic: text('logic'),
  quality: text('quality'),
  risk: text('risk'),
  conclusion: text('conclusion'),
  requirement: text('requirement'),
  testPath: text('test_path'),
  globalNotes: text('global_notes'), // 发评论前言
  reviewInstruction: text('review_instruction'), // 给 AI 的审核指令（重新审核时参考）
  // 发评论锚点：上次发评论时的 head sha → 刷新时和当前 head 比对，判断作者有没有又 push
  lastPostSha: text('last_post_sha'),
  lastPostUrl: text('last_post_url'),
  // 刷新时发现作者在你上次发评论后又 push 了 → 持久化，列表/抽屉据此显示「作者已更新」
  authorUpdated: integer('author_updated', { mode: 'boolean' }).notNull().default(false),
  // GitHub PR 评审决定 APPROVED / CHANGES_REQUESTED / REVIEW_REQUIRED（刷新时取）→ PR 徽章显示「已批准」等
  reviewDecision: text('review_decision'),
  // 预览缓存：组装好的英文评论 JSON + 输入签名（签名变了才重新生成）
  previewJson: text('preview_json'),
  previewSig: text('preview_sig'),
  error: text('error'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

// 单条 finding
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
  checked: integer('checked', { mode: 'boolean' }).notNull().default(false), // 发到 PR comment
  notes: text('notes'),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: text('created_at').notNull(),
})

// 复审追加（每条 finding 多轮）
export const findingRechecks = sqliteTable('finding_rechecks', {
  id: text('id').primaryKey(),
  findingId: text('finding_id')
    .notNull()
    .references(() => findings.id, { onDelete: 'cascade' }),
  round: integer('round').notNull(),
  // 复审(作者改了没): fixed/partial/unaddressed/replied/new
  // 带反馈复审(AI 回应我的 note): kept/retracted/adjusted/discuss/new
  status: text('status', {
    enum: ['fixed', 'partial', 'unaddressed', 'replied', 'new', 'kept', 'retracted', 'adjusted', 'discuss'],
  }).notNull(),
  text: text('text'),
  at: text('at').notNull(),
})

// 发评论记录（多轮）
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

// 事件流（进度 + 历史，喂 SSE）
export const events = sqliteTable('events', {
  id: text('id').primaryKey(),
  reviewId: text('review_id')
    .notNull()
    .references(() => reviews.id, { onDelete: 'cascade' }),
  ts: text('ts').notNull(),
  kind: text('kind').notNull(), // queued|stage|finding|error|posted|recheck|...
  message: text('message'),
})

// 一次「修复我的 PR」= 一行。从一个 PR 发起（不一定有 review），独立于 reviews。
// agent 改代码 → Node 本地 commit（不 push）→ 用户看 diff → 点「推送」才 push。
export const fixes = sqliteTable('fixes', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  prNumber: integer('pr_number').notNull(),
  branch: text('branch').notNull(),
  steps: text('steps').notNull(), // JSON: { fix, simplify, tests, testsUI }
  status: text('status', {
    enum: ['queued', 'running', 'ready', 'pushing', 'pushed', 'error', 'discarded'],
  })
    .notNull()
    .default('queued'),
  stage: text('stage'), // 当前细粒度阶段文案（实时展示）
  worktreePath: text('worktree_path'), // 保留到 push/discard 才清
  baseHeadSha: text('base_head_sha'), // 改动前的 PR head（diff 基线）
  fixHeadSha: text('fix_head_sha'), // 本地 commit 后的 head
  filesChanged: integer('files_changed'),
  additions: integer('additions'),
  deletions: integer('deletions'),
  testsResult: text('tests_result'), // passed/failed/skipped + 摘要
  costUsd: real('cost_usd'),
  error: text('error'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  pushedAt: text('pushed_at'),
})

export type Project = typeof projects.$inferSelect
export type Skill = typeof skills.$inferSelect
export type Review = typeof reviews.$inferSelect
export type Finding = typeof findings.$inferSelect
export type FindingRecheck = typeof findingRechecks.$inferSelect
export type Post = typeof posts.$inferSelect
export type ReviewEvent = typeof events.$inferSelect
export type Fix = typeof fixes.$inferSelect

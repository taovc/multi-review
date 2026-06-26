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
  provider: text('provider', { enum: ['claude', 'codex'] }).notNull().default('claude'),
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

// 一次「修复 PR」任务（纯对话版）：在 PR 分支的 worktree 里和 Claude 对话改代码（不自动 commit），
// 用户点「提交并上传」才 commit + push。没有验证/批量修复/合并基础分支/回复作者这些阶段。
// worktree 第一条对话时惰性建，保留到 push/discard。
export const fixes = sqliteTable('fixes', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  prNumber: integer('pr_number').notNull(),
  branch: text('branch').notNull(),
  prAuthor: text('pr_author'), // PR 作者（展示 / reviewer-updated 用；push 不再限制只能自己的 PR）
  title: text('title'),
  instruction: text('instruction'), // 建任务时 prompt 框里的针对性指示（可空 = 用系统默认）
  lang: text('lang').notNull().default('en'), // 工作语言 = 建任务时的 UI locale（verdict/反馈用它写）
  // open：建好/聊着、无待上传改动；ready：对话改了代码、有未提交/未推改动待上传；pushing：上传中；pushed：已上传；error：失败。
  // discarded 是历史枚举值（discard 现在硬删行，不会再设）。
  status: text('status', {
    enum: ['open', 'ready', 'pushing', 'pushed', 'error', 'discarded'],
  })
    .notNull()
    .default('open'),
  stage: text('stage'), // 当前细粒度阶段文案（实时展示）
  summary: text('summary'), // 验证阶段的整体结论
  worktreePath: text('worktree_path'),
  baseRef: text('base_ref'), // PR 的目标分支名（diff 三点基线 origin/<baseRef>...HEAD + merge 用）
  baseHeadSha: text('base_head_sha'), // 改动前的 PR head（diff 基线）
  fixHeadSha: text('fix_head_sha'), // 本地 commit 后的 head
  lastPushSha: text('last_push_sha'), // 最近成功 push 上去的 commit；和 fixHeadSha 不等 = 有未上传改动
  lastActionKind: text('last_action_kind', { enum: ['pushed'] }), // 最近一次对外动作（上传）→ 「查看改动」入口
  reviewsAtPush: integer('reviews_at_push'), // push 修复时 PR 的 review 数；之后变多 = reviewer 又审了（「审核已更新」基线）
  filesChanged: integer('files_changed'),
  additions: integer('additions'),
  deletions: integer('deletions'),
  sessionId: text('session_id'), // claude stream-json 的会话 id（后续 --resume 续聊）
  codexSessionId: text('codex_session_id'), // codex thread id（resumeThread 续聊）；与 claude 各存各的，切换 provider 不混用
  lastUploadAt: text('last_upload_at'), // 上次上传时间 → 「审核已更新」基线（M3）
  costUsd: real('cost_usd'),
  error: text('error'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  pushedAt: text('pushed_at'),
})

// M2 对话跟进：修复出稿后在 drawer 里继续聊、继续改（claude --resume 续会话）。
// append-only，按 seq 排序；assistant 轮流式写入。重启恢复 + 展示都靠它。
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

// 修复任务的进度事件（验证/修复/对话中 agent 一行行的动作）。和 events 表对 reviews 同构，
// 单独建是因为 events FK 到 reviews。落库后打开任务能回填历史日志（同审核 drawer）。
export const fixEvents = sqliteTable('fix_events', {
  id: text('id').primaryKey(),
  fixId: text('fix_id')
    .notNull()
    .references(() => fixes.id, { onDelete: 'cascade' }),
  ts: text('ts').notNull(),
  kind: text('kind').notNull(),
  message: text('message'),
})

// ── 全局 chatbot 抽屉：独立于 PR/项目的自由会话（bypassPermissions「啥都能干」助手）。
// 一行 = 一段对话（支持历史列表/翻页/删除）。session_id/codex_session_id 各存各的，切 provider 不混用。
export const globalSessions = sqliteTable('global_sessions', {
  id: text('id').primaryKey(),
  title: text('title'), // 首条消息摘要，历史列表展示用（空 = 未命名）
  provider: text('provider', { enum: ['claude', 'codex'] }).notNull().default('claude'),
  model: text('model'), // 空 = 跟随默认
  cwd: text('cwd'), // 工作目录（/cd 可换；换目录通常另起新会话）
  sessionId: text('session_id'), // claude 续聊 id
  codexSessionId: text('codex_session_id'), // codex thread id
  status: text('status', { enum: ['idle', 'streaming', 'error'] }).notNull().default('idle'),
  error: text('error'),
  createdAt: text('created_at').notNull(),
  lastUsedAt: text('last_used_at').notNull(), // 历史列表按它倒序 + 翻页
})

// 全局会话的对话轮（append-only，按 seq 排序；assistant 轮流式写入）。
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

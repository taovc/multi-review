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
  codexServiceTier: text('codex_service_tier'), // Codex 专用服务档位；null=不覆盖，fast=启用快速档
  // 自动化「修复↔复查」每条 PR 的回合上限（防自驱闭环烧 token）。在项目配置里和模型选择同处编辑。
  autoMaxRounds: integer('auto_max_rounds').notNull().default(2),
  // 自动化冷却期（分钟）：某条 PR 的 head 第一次被看到后等这么久才动手，给用户时间进去关掉不想跑的。0=不冷却。
  autoCooldownMinutes: integer('auto_cooldown_minutes').notNull().default(5),
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
      'posting', // 发评论「认领」中：组装/翻译/发布的整个窗口占住此状态，防并发重复发/发旧内容
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

// ── Feature 开发闭环。
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
  // 单段式状态：working=在开发/可继续 · awaiting=agent 在等你拍板(ask-user) · opened=PR 已开 · error。
  status: text('status', {
    enum: ['working', 'awaiting', 'opened', 'error'],
  })
    .notNull()
    .default('working'),
  planJson: text('plan_json'), // 遗留列（两段式方案已删，保留列避免破坏旧库；不再写）
  decisions: text('decisions'), // 遗留列，同上
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

// ── PR 自动化（自动审核 / 自动修复）。一条项目级配置 + 每条 PR 的运行态。
// 引擎（server/plugins/automation.ts 的轮询）读这两张表 + GitHub 状态，复用现有端点派活。
// 项目级：自动化配置弹窗存这里（每个项目一行）。authors/statuses 是 JSON 数组（空数组=不限）。
export const projectAutomation = sqliteTable('project_automation', {
  projectId: text('project_id')
    .primaryKey()
    .references(() => projects.id, { onDelete: 'cascade' }),
  masterEnabled: integer('master_enabled', { mode: 'boolean' }).notNull().default(false), // 弹窗底部「是否开启系统」总闸
  reviewEnabled: integer('review_enabled', { mode: 'boolean' }).notNull().default(false), // 自动审核系统开关
  reviewMode: text('review_mode', { enum: ['once', 'every_push'] }).notNull().default('once'), // 一次 / 每次push（每次push=作者更新后自动复查）
  reviewAuthors: text('review_authors').notNull().default('[]'), // JSON string[]，空=不限作者
  reviewStatuses: text('review_statuses').notNull().default('["open"]'), // JSON string[]（pullKey: open/draft/merged/closed），默认 open（草稿默认不勾）
  fixEnabled: integer('fix_enabled', { mode: 'boolean' }).notNull().default(false), // 自动修复系统开关
  fixAuthors: text('fix_authors').notNull().default('[]'),
  fixStatuses: text('fix_statuses').notNull().default('["open"]'),
  updatedAt: text('updated_at').notNull(),
})

// 自动化工作流时间线：引擎对某条 PR 做了什么（创建审核/审核/发评论/修复/上传/复查/封顶/收敛…），按时间排。
// PR 抽屉的「自动化」tab 据此渲染时间线。和 events/fix_events 同构，但按 (projectId, prNumber) 而非任务 id 归集，
// 这样删了 review/fix 任务后历史仍在。
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

// 每条 PR 的自动化运行态 + 实例级覆盖开关（PR 抽屉里的两个 switch）。
// reviewOn/fixOn 为 null = 跟随项目配置（继承）；显式 0/1 = 用户在该 PR 上覆盖。
// 删除审核/修复任务 → optOut=1（防全局配置在下一轮把它复活）。重新打开开关 → 清零 round/note/optOut。
export const prAutomation = sqliteTable('pr_automation', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  prNumber: integer('pr_number').notNull(),
  reviewOn: integer('review_on', { mode: 'boolean' }), // null=继承配置
  fixOn: integer('fix_on', { mode: 'boolean' }), // null=继承配置
  round: integer('round').notNull().default(0), // 已派出的自动修复次数（到 autoMaxRounds 即封顶）
  lastFixReviewSha: text('last_fix_review_sha'), // 上次针对哪个 review head 派过修复（同一 head 不重复修）
  pendingFix: integer('pending_fix', { mode: 'boolean' }).notNull().default(false), // 已派修复、等它跑完（push / 判定修不动）
  optOut: integer('opt_out', { mode: 'boolean' }).notNull().default(false), // 用户删任务 → 本 PR 退出自动化，直到手动再开
  note: text('note'), // 引擎最近一次的停手原因：capped/converged/cant_fix/fix_error/user_off（喂 UI 提示）
  // 冷却期：引擎第一次看到这个 head 的 sha + 时间。head 变了就重置；未过 autoCooldownMinutes 不动手。
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

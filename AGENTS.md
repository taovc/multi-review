# pr-cockpit / Multi Review

## 项目定位

- 这是用户的本地批量 PR 审核工作台，产品名是 Multi Review，仓库路径通常是 `/Users/openstudio/work/products/tools/pr-cockpit`。
- 核心流程：拉取 GitHub PR 列表，给每个 PR 建隔离 worktree，AI 产出结构化 review，人类在 Web UI 里把关后再发 GitHub 行级/汇总评论。
- 技术栈：Nuxt 4 + @nuxt/ui/Tailwind v4，better-sqlite3 + drizzle，Nitro `server/api/`，本地 `gh` CLI，`@anthropic-ai/claude-agent-sdk` 和 `@openai/codex-sdk`。
- 主要目录：`core/` 是业务和 agent 引擎，`server/api/` 是 Nitro API，`app/` 是 Vue UI，`tests/` 是轻量合同/回归测试，`data/` 是本地 SQLite 和旧集中 worktree 迁移源。

## 本地运行

- 常用检查：`pnpm typecheck`、`pnpm test`，风险较大的 UI/打包改动再跑 `pnpm build`。
- Dev server：`pnpm dev`，README 默认是 `http://localhost:3001`。
- 用户机器上的常驻 pr-cockpit 实例通常在端口 `5332`，`4737` 是另一个项目。动进程前先确认端口，不要按 `.output/server/index.mjs` 进程名误杀。
- SQLite 没有正式 drizzle migration 流程。实际建表在 `core/db/client.ts` 的 `ensureSchema()` 和 `ensureColumns()`，`core/db/schema.ts` 只提供查询类型。改 DB 时要同步这两处，并保持启动重跑幂等。
- 默认 worktree 位置是每个项目本地 clone 内的 `pr-cockpit-worktrees/<taskId>`；启动恢复会把仍存在的旧 `./data/worktrees/<taskId>` 持久 fix/feature worktree 用 `git worktree move` 迁过去。`WORKTREE_LOCATION=central` 才继续使用 `REPOS_DIR`。

## 改代码时的约束

- 不要只信旧文档或 Claude memory。这里演进很快，做行为判断时优先读当前源码、测试和最近 commit。
- Review agent 的硬约束是只读：只能审，不改文件，不 git 写，不 gh 写。对外发评论必须由引擎在用户确认后执行。
- Provider 相关改动要保持 Claude/Codex 边界清楚。项目 provider、模型、effort、session id 都要按当前 provider 走；不要拿 Claude session id resume Codex thread，反之也不行。
- Codex 代码路径优先复用现有 helper。历史上裸 `new Codex()` 在生产 bundle 里踩过二进制解析问题，新增入口应检查并复用 `core/agent/codexAgent.ts` 里的封装。
- Codex SDK 的 `type: "error"` item 可能只是非致命 warning；致命失败要看当前 runner 对 `turn.failed`、顶层 error、无最终输出等的处理，不要机械地见 error item 就 throw。
- Fix / Feature / Global chat 是会写 worktree 或跑命令的区域。默认不要让 agent 自己 push 或 `gh pr create`；涉及 `allowDanger`、网络、danger guard 的改动要逐条确认当前 provider 的真实执行边界。
- PR automation 是高风险区。任何 live 验证都可能触发 review/comment/fix/push，除非用户明确要求，不要对真实 PR 开自动化冒烟。优先用单测和 mock。

## 前端/UI 约定

- 这是工作台，不是落地页。界面应偏密集、可扫描、少装饰，优先复用已有 @nuxt/ui、lucide/iconify 和本地组件风格。
- Drawer 里不要再套普通 modal 做确认；历史上 drawer 上的弹窗交互容易出问题。用现有内联确认模式，例如 `useInlineConfirm`。
- 异步 `load()` 写组件状态时要防 stale result：记录 load token 和当前 id，await 后确认仍是同一个实体再落值；SSE handler 也要检查打开时捕获的 id；切换实体时清空旧的 live/log/detail 状态。
- Operational screens 不要无理由套窄 `max-w-2xl` / `max-w-3xl`；这里的表格、drawer、diff、日志都应该充分利用横向空间。

## 历史风险点

- `post.post.ts` 曾有发布评论并发竞态，修法是 posting 状态和 CAS 认领。碰 review 发布、recheck、automation dispatch 时要确认没有重新打开这个窗口。
- 自动化曾出现 push 热循环、默认修别人 PR、findings 状态误判等问题。当前代码已有修复，但相关逻辑仍要靠测试锁住。
- LAN remote access PR #51 的历史审查结论是 request changes：CSRF/Host/DNS rebinding/SSE/token 暴露等风险未应假定已修，除非当前代码或后续 PR 明确证明。
- `runClaudeStream` 默认是 20 分钟空闲超时加 4 小时硬上限；无人值守路径如果复用它，可能需要显式更短 timeout。

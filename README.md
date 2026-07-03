<div align="center">
  <img src="public/logo.svg" width="64" height="64" alt="Multi Review" />
  <h1>Multi Review</h1>
  <p>本地批量 PR 审核工作台 · 终端 Claude agent 为核心，web 做人工把关与状态管理</p>
</div>

<div align="center">

**中文** · [Français](README.fr.md) · [English](README.en.md)

</div>

---

不再逐个在终端审 PR：把一个仓库的 PR 拉进来批量勾选 → AI 在隔离的只读 git worktree 里逐个审 → 你在 web 里把关 findings、写反馈 → 行级+汇总评论发回 GitHub → 作者改后一键复查。每个项目挂自己的审核方法学（skill）和模型/力度。

## 功能支持

**PR 工作台**
- 直接拉仓库 PR 列表（`gh pr list`，GraphQL cursor 分页，每页 20），按状态（进行中/已合并/已关闭/全部）和作者筛选
- 勾选若干 PR 一键建审核任务；右侧 drawer 看 PR 详情（时间线 / 改动 diff），评论与描述 markdown 渲染
- 「全部 PR」「审核任务」两个 Tab；任务列表自动轮询刷新，状态变化无需手动刷新

**AI 审核**
- agent 在隔离 git worktree 里**只读**审核（带 git/grep 工具），输出结构化 findings（严重度 + path:line + 问题/详情/修复）+ 需求描述 + 手动测试路径
- 实时进度日志（SSE，像终端一行行）；进度与结果落库
- **按我反馈复审**：保留你的勾选/notes，按你每条 note + 审核指令做针对性复审，AI 逐条回应（维持/撤回/调整/想讨论）
- **复查作者改动**：读你评论后的新 commit，逐条判断已修复/部分/未处理

**人工把关 + 发布**
- 逐条 finding 勾选「发到 PR comment」+ 写 note（note 作为编辑指令融进评论，不原样泄漏）
- 发布前预览（dry-run，可缓存/重新生成）；中文 findings 自动翻成专业英文；行级评论挂到代码行、挂不上的进汇总
- 发布走 `gh api .../reviews`，自愈处理残留 pending review

**每项目配置**
- 模型 + 审核力度（effort）从本地登录的 `claude` 真实读取（`supportedModels()`），带 CLI 同款描述
- 多套审核 skill，选一套启用；**AI 生成/赋能**：读本地仓库文档+架构生成贴合该项目的方法学（可给自定义指令介入），存为新候选 + diff 对比后再启用，绝不覆盖

**安全与一致性**
- 审核 agent 只读：工具层硬拦截 git 写 / 文件改 / 联网 / 危险命令（不靠 prompt，物理拦截）+ 操作契约前置 + skill 体检
- 同仓库 git 操作互斥（防并发 fetch 抢引用）；findings 写入用事务；删除任务同步清 worktree；服务重启恢复中断任务
- 所有破坏性操作（删项目/删任务/清理）走项目内确认弹窗，不用原生 window 弹框

## 技术栈

Nuxt 4 + @nuxt/ui（Tailwind v4，极简单色风）· better-sqlite3 + drizzle · `@anthropic-ai/claude-agent-sdk`（带 git 工具、cwd=worktree）· 本地 `gh` CLI。

## 前置

- Node ≥ 22、pnpm 9
- `gh auth login` 已登录（GitHub 读写全走它）
- 本地已登录 `claude`（走订阅，基本不额外花 API 钱）或填 `ANTHROPIC_API_KEY`

## 安装

首次运行的分步指南。精简版见下方「起步」。

**1. 检查前置条件**

```bash
node -v      # ≥ 22
pnpm -v      # 9.x  （否则：corepack enable && corepack prepare pnpm@9 --activate）
gh --version
gh auth status   # 应显示「Logged in」；否则：gh auth login
```

同时确认本地 `claude` CLI 已登录（走订阅，基本不额外花 API 钱）。若未登录，则在第 3 步填 `ANTHROPIC_API_KEY`。

**2. 获取项目**

```bash
git clone <仓库地址>
cd multi-review
```

**3. 配置环境**

```bash
cp .env.example .env
```

所有变量都有合理默认值；实际只需按需调整：

| 变量 | 何时修改 |
|---|---|
| `PORT` | `3001` 被占用时 |
| `INFERENCE_PROVIDER` | `claude`（本地订阅，默认）或 `anthropic-api` |
| `ANTHROPIC_API_KEY` | **仅**在 `anthropic-api` 模式，或本地 `claude` 未登录时 |

全部变量详见 [配置（.env）](#配置env) 一节。

**4. 安装依赖**

```bash
pnpm install
```

`postinstall` 会自动执行 `nuxt prepare`（生成 Nuxt 类型）。

**5. 首次启动**

```bash
pnpm dev      # http://localhost:3001
```

首次启动时，**SQLite 数据库（`./data/cockpit.db`）和 worktrees 目录（`./data/worktrees`）会自动创建** —— 无需手动跑 migration。Drizzle schema 在运行时自建（`core/db/client.ts` 中的 `ensureSchema()` / `ensureColumns()`）。

**6. 生产构建（可选）**

```bash
pnpm build
pnpm preview
```

**排错**

- **端口被占用** → 改 `.env` 里的 `PORT`。
- **`gh` 未认证** → `gh auth login`（GitHub 读写都依赖它）。
- **查看数据库** → `pnpm db:studio`（打开 Drizzle Studio）。

## 起步

```bash
cp .env.example .env      # 按需改 PORT / 模型 / 路径
pnpm install
pnpm dev                  # 默认 http://localhost:3001
```

进去左侧「＋」创建项目（填仓库 owner/repo + 本地 clone 路径），到项目配置里「AI 生成」一套审核 skill 并启用，再去「全部 PR」勾选 PR 开审。

## 配置（.env）

见 `.env.example`，关键项：

| 变量 | 示例 | 说明 |
|---|---|---|
| `PORT` | `3001` | 端口 |
| `INFERENCE_PROVIDER` | `claude` | `claude`(本地订阅) / `anthropic-api` |
| `ANTHROPIC_MODEL` | `sonnet` | 审核默认模型（项目里可覆盖） |
| `CODEX_MODEL` |  | Codex 项目默认模型；留空走 Codex 默认 |
| `CODEX_SERVICE_TIER` |  | 可选，Codex/OpenAI 全局默认速度档；项目配置页的 Fast 开关会按项目覆盖它。取消全局 fast 就留空/删除，若 `~/.codex/config.toml` 也设置了 `service_tier`，那里也要删除 |
| `CODEX_PROJECT_DOC_FALLBACK_FILENAMES` | `CLAUDE.md,.claude/CLAUDE.md` | 无 `AGENTS.md` 时 Codex 读取的项目说明 fallback |
| `TRANSLATE_MODEL` | `sonnet` | 发评论中→英翻译用的轻量模型 |
| `ANTHROPIC_API_KEY` | `sk-ant-...` | 仅 api 模式或本地未登录时 |
| `DEFAULT_REPO` | `owner/repo` | 可选，粘纯数字 PR 时的默认仓库 |
| `DB_PATH` | `./data/cockpit.db` | SQLite 路径 |
| `REPOS_DIR` | `./data/worktrees` | review 的 git worktree 落地根 |
| `MAX_CONCURRENCY` | `3` | 并行审核上限 |

## 目录

```
core/      引擎：db / github / git(worktree) / agent(review·recheck·skillgen·capabilities·guard·jsonSalvage) / pipeline / queue / events / skillLint
server/    Nuxt API：projects / reviews / skills / agent(capabilities) / SSE / 启动恢复 plugin
app/       UI：左侧项目导航；项目页(全部 PR / 审核任务 / 项目配置)；PR drawer(AI审核 / 时间线 / 改动)
docs/      ARCHITECTURE.md — 设计目的 + 不变量 + 安全防御说明
data/      SQLite + worktrees（git 忽略）
```

设计目的、不变量与安全防御详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

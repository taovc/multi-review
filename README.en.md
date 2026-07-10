<div align="center">
  <img src="public/logo.svg" width="64" height="64" alt="Multi Review" />
  <h1>Multi Review</h1>
  <p>Local AI PR cockpit · batch review, fix chat, feature development and a global assistant with Claude/Codex providers</p>
</div>

<div align="center">

[中文](README.md) · [Français](README.fr.md) · **English**

</div>

---

No more reviewing PRs one at a time in the terminal, and no more scattering fixes and feature work across separate shells. Pull a repo's PRs into the cockpit → the AI reviews, rechecks, fixes, or develops inside isolated worktrees → you gate findings, conversations, diffs, pushes and PR creation in the web UI → GitHub remains the external system of record. Each project can choose Claude or Codex with its own model, effort and review methodology.

## Features

**PR workbench and review**
- Pull a repo's PR list through `gh` / GraphQL, then filter by author, PR state, review state, fix state and worktree state.
- The right-side drawer shows AI review, fix chat, timeline and diff, with descriptions and comments rendered as markdown.
- The AI reviews in an isolated read-only git worktree and produces structured findings: severity, `path:line`, problem, detail and fix guidance.
- Feedback-guided re-review keeps your checkboxes/notes; author-change recheck reads the latest commits and judges each finding.

**Human gate + publishing**
- Per-finding checkbox to "post as a PR comment" + a note (the note is woven into the comment as an edit instruction, not leaked verbatim).
- Pre-publish preview (dry-run, cacheable / regenerable); findings in any working language are rewritten as professional English GitHub comments.
- Publishing goes through `gh api .../reviews`, with a posting claim and self-healing cleanup of leftover pending reviews.

**Fix PRs**
- The fix tab is a persistent chat: the agent edits the PR worktree, but does not commit or push by default.
- "Commit and upload" first shows the diff plus an editable conventional commit message; only confirmation runs `git add/commit/push`.
- Supports stop/resume, expandable run logs, decision cards, persistent ultracode and an explicit dangerous-command toggle.

**Feature development and global assistant**
- The "Feature development" tab creates an isolated feature worktree from a requirement and lets the agent develop in a single native chat loop.
- Real decision points are rendered as `ask-user` cards. Opening a PR is an explicit action that allows the agent to commit, push and run `gh pr create` for that turn.
- The bottom-right global assistant inherits project provider/cwd when available and supports commands such as `/cd`, `/resume` and `/clear`.

**Per-project config**
- Each project chooses Claude or Codex. Review, fix chat, recheck, skill generation and publish-time rewriting follow that provider without mixing sessions or models.
- Claude models come from the local `claude`; Codex uses preset/default models. Effort, Codex Fast/service tier and methodology are configurable per project.
- Multiple review skills, one active at a time; AI generation reads the local repo docs and architecture, saves a candidate and lets you diff before activation.

**Safety & consistency**
- Review agents are read-only: tool-level blocking for git writes, file edits, network access and dangerous commands, plus an operating contract and skill linting.
- Write-capable paths run inside isolated worktrees; push, PR creation and dangerous commands require explicit UI action or toggles.
- Git operations on the same repo are serialized; findings are transactional; deleted tasks clean worktrees; restarts recover or stop interrupted work.
- PR automation is high-risk and disabled by default; when enabled it reuses the existing review/post/fix/push endpoints from a server-side poller.

## Tech stack

Nuxt 4 + @nuxt/ui (Tailwind v4) · better-sqlite3 + drizzle · `@anthropic-ai/claude-agent-sdk` · `@openai/codex-sdk` · local `gh` CLI · Electron packaging that runs Nitro under Electron's Node mode.

## Prerequisites

- Node ≥ 22, pnpm 9
- `gh auth login` completed (all GitHub reads/writes go through it)
- Claude provider: local `claude` login or `ANTHROPIC_API_KEY`
- Codex provider: local Codex login or `OPENAI_API_KEY`

## Installation

Step-by-step guide for a first run. See "Getting started" below for the condensed version.

**1. Check the prerequisites**

```bash
node -v      # ≥ 22
pnpm -v      # 9.x  (otherwise: corepack enable && corepack prepare pnpm@9 --activate)
gh --version
gh auth status   # must show "Logged in"; otherwise: gh auth login
```

Also confirm the provider you plan to use is available: Claude needs a local `claude` login or `ANTHROPIC_API_KEY`; Codex needs a local Codex login or `OPENAI_API_KEY`.

**2. Get the project**

```bash
git clone <repo-url>
cd multi-review
```

**3. Configure the environment**

```bash
cp .env.example .env
```

Every variable has a sensible default; in practice you only adjust:

| Variable | When to change it |
|---|---|
| `PORT` | If `3001` is already taken |
| `INFERENCE_PROVIDER` | `claude` (default) or `codex` |
| `ANTHROPIC_API_KEY` | Optional for the Claude path; use when local `claude` login is unavailable |
| `OPENAI_API_KEY` | When local Codex login is unavailable and you want to use an OpenAI API key |

The full list of variables is in the [Configuration (.env)](#configuration-env) section.

**4. Install dependencies**

```bash
pnpm install
```

The `postinstall` step automatically runs `nuxt prepare` (Nuxt type generation).

**5. First run**

```bash
pnpm dev      # http://localhost:3001
```

On first start, **the SQLite database (`./data/cockpit.db`) and the worktrees folder (`./data/worktrees`) are created automatically** — no manual migration to run. The Drizzle schema is set up on the fly (`ensureSchema()` / `ensureColumns()` in `core/db/client.ts`).

**6. Production build (optional)**

```bash
pnpm build
pnpm preview
```

Electron preview / packaging:

```bash
pnpm electron:preview
pnpm electron:dist
```

**Troubleshooting**

- **Port already in use** → change `PORT` in `.env`.
- **`gh` not authenticated** → `gh auth login` (GitHub reads/writes depend on it).
- **Inspect the database** → `pnpm db:studio` (opens Drizzle Studio).

## Getting started

```bash
cp .env.example .env      # adjust PORT / model / paths as needed
pnpm install
pnpm dev                  # defaults to http://localhost:3001
```

Once inside, click the "＋" on the left to create a project (fill in `owner/repo` + the local clone path), configure provider/model/effort and generate a review skill. Then use "All PRs" for review/fix work or "Feature development" for new feature worktrees.

## Configuration (.env)

See `.env.example`; key entries:

| Variable | Example | Description |
|---|---|---|
| `PORT` | `3001` | Port |
| `INFERENCE_PROVIDER` | `claude` | `claude` / `codex` |
| `ANTHROPIC_MODEL` | `sonnet` | Default review model (overridable per project) |
| `CODEX_MODEL` |  | Default model for Codex projects; empty uses the Codex default |
| `CODEX_SERVICE_TIER` |  | Optional global default Codex/OpenAI speed tier; the project-level Fast toggle overrides it. To disable global fast, leave/delete it and also remove `service_tier` from `~/.codex/config.toml` if set globally |
| `CODEX_PROJECT_DOC_FALLBACK_FILENAMES` | `CLAUDE.md,.claude/CLAUDE.md` | Project docs Codex reads when `AGENTS.md` is absent |
| `OPENAI_API_KEY` | `sk-...` | Optional when local Codex login is unavailable |
| `TRANSLATE_MODEL` | `sonnet` | Lightweight model for rewriting GitHub comments into English |
| `ANTHROPIC_API_KEY` | `sk-ant-...` | Optional for the Claude path when local login is unavailable |
| `DEFAULT_REPO` | `owner/repo` | Optional, default repo when pasting a bare PR number |
| `DB_PATH` | `./data/cockpit.db` | SQLite path |
| `REPOS_DIR` | `./data/worktrees` | Root where review git worktrees land |
| `MAX_CONCURRENCY` | `3` | Maximum number of parallel reviews |

## Directory layout

```
core/      Engine: db / github / git(worktree) / agent(review·fix·feature·global·codex·skillgen) / automation / pipeline / events
server/    Nuxt API: projects / reviews / fixes / features / global sessions / skills / SSE / startup recovery plugin
app/       UI: project nav; project page (Feature development / All PRs / Config); PR drawer (AI review / Fix / Timeline / Changes)
electron/  Desktop shell: starts Nitro and loads the local HTTP UI
docs/      ARCHITECTURE.md — design goals + invariants + safety mechanisms
data/      SQLite + worktrees (git-ignored)
```

Design goals, invariants and safety defenses are detailed in [docs/ARCHITECTURE.en.md](docs/ARCHITECTURE.en.md).

# pr-cockpit / PR Cockpit

## What this project is

- This is the user's local batch PR review workbench. The product name is PR Cockpit; the repo usually lives at `/Users/openstudio/work/products/tools/pr-cockpit`.
- Core flow: pull the GitHub PR list, give each PR an isolated worktree, have the AI produce a structured review, and let the human vet it in the web UI before posting line-level/summary comments to GitHub.
- Stack: Nuxt 4 + @nuxt/ui/Tailwind v4, better-sqlite3 + drizzle, Nitro `server/api/`, the local `gh` CLI, `@anthropic-ai/claude-agent-sdk` and `@openai/codex-sdk`.
- Main directories: `core/` is the business logic and agent engine, `server/api/` is the Nitro API, `app/` is the Vue UI, `tests/` holds lightweight contract/regression tests, `data/` is the local SQLite plus the migration source for the old central worktrees.

## Running locally

- Usual checks: `pnpm typecheck`, `pnpm test`; also run `pnpm build` for riskier UI/bundling changes.
- Dev server: `pnpm dev`, README defaults to `http://localhost:3001`.
- The long-running pr-cockpit instance on the user's machine is usually on port `5332`; `4737` is a different project. Confirm the port before touching processes — don't kill the wrong project's server by matching on the `.output/server/index.mjs` process name.
- SQLite has no formal drizzle migration flow. Tables are actually created by `ensureSchema()` and `ensureColumns()` in `core/db/client.ts`; `core/db/schema.ts` only provides query types. When changing the DB, update both places and keep them idempotent, so that re-running them on every startup stays safe.
- The default worktree location is `.pr-cockpit-worktrees/<taskId>` inside each project's local clone; that directory is written into the target repo's `.git/info/exclude` (local only, not committed) — do **not** touch the target repo's shared `.gitignore`. That exclude line does not stop IDEs from discovering those worktrees — editors find repos by scanning the filesystem, not by reading gitignore/exclude; what actually decides discovery is the editor's own scan depth setting (in VS Code, `git.repositoryScanMaxDepth`, default 1, needs to be ≥2). On startup, recovery moves any still-existing old `./data/worktrees/<taskId>` persistent fix/feature worktrees over with `git worktree move`, and clears paths pointing at directories that are gone. Only `WORKTREE_LOCATION=central` keeps using `REPOS_DIR`.

## Constraints when changing code

- Don't trust old docs or Claude memory alone. This evolves fast — when judging behavior, read the current source, tests and recent commits first.
- The review agent's hard constraint is read-only: it may only review — it must not edit files, must not perform any git write, and must not perform any gh write. Posting comments externally must be done by the engine, after the user confirms.
- Provider-related changes must keep the Claude/Codex boundary clean. Project provider, model, effort and session id all have to follow the current provider; don't resume a Codex thread with a Claude session id, or vice versa.
- Codex code paths should reuse existing helpers. Historically, a bare `new Codex()` hit binary resolution problems in the production bundle — new entry points should check for and reuse the wrapper in `core/agent/codexAgent.ts`.
- A `type: "error"` item from the Codex SDK may just be a non-fatal warning; for fatal failures, look at how the current runner handles `turn.failed`, top-level errors, no final output, etc. — don't mechanically throw on every error item.
- Fix / Feature / Global chat are the areas that write to worktrees or run commands. By default, don't let the agent push or run `gh pr create` on its own; for changes involving `allowDanger`, the network, or the danger guard, verify the current provider's real execution boundary case by case.
- PR automation is a high-risk area. Any live verification can trigger review/comment/fix/push — unless the user explicitly asks for it, don't run automation smoke tests against real PRs. Prefer unit tests and mocks.

## Frontend/UI conventions

- This is a workbench, not a landing page. The UI should be dense, scannable and lightly decorated, and should reuse the existing @nuxt/ui, lucide/iconify and local component styles.
- Don't nest a regular modal inside a drawer for confirmation; modal-on-drawer interactions have caused problems historically. Use the existing inline confirmation pattern, e.g. `useInlineConfirm`.
- When an async `load()` writes component state, guard against stale results: record a load token and the current id, and after the await confirm it is still the same entity before committing the value; SSE handlers must also check the id captured when they opened. Clear stale live/log/detail state when switching entities.
- Don't wrap operational screens in a narrow `max-w-2xl` / `max-w-3xl` without reason; tables, drawers, diffs and logs here should all use the horizontal space fully.

## Historical risk areas

- `post.post.ts` used to have a concurrency race when posting comments; the fix was a posting state plus CAS claiming. When touching review posting, recheck or automation dispatch, make sure that window hasn't been reopened.
- Automation has previously had problems such as push hot loops, fixing other people's PRs by default, and misjudged findings state. The current code has fixes for these, but the logic still has to be locked down by tests.
- The historical review verdict on the LAN remote access PR #51 was request changes: risks such as CSRF/Host/DNS rebinding/SSE/token exposure must not be assumed fixed unless the current code or a later PR clearly proves it.
- `runClaudeStream` defaults to a 20-minute idle timeout plus a 4-hour hard limit; unattended paths reusing it may need an explicitly shorter timeout.

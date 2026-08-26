import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { appendFileSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'

const pexec = promisify(execFile)
// Leading dot: a worktree is a full copy of the source, and inside the project repo it gets picked up
// by the project's own tsc / eslint / vitest / build (duplicate definitions, duplicate test cases,
// doubled search results). Most tools skip dot directories by default, while IDE file trees and repo
// scans ignore the dot — full visibility, minimal toolchain interference.
const REPO_WORKTREES_DIR = '.pr-cockpit-worktrees'
export type WorktreeLocation = 'repo' | 'central'

// One mutex per local repo: concurrent reviews run git fetch / worktree add against the same .git,
// and updating refs/remotes/origin/* at the same time hits "cannot lock ref". Serialize the git
// preparation for a given repo.
const repoLocks = new Map<string, Promise<unknown>>()
async function withRepoLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = repoLocks.get(key) ?? Promise.resolve()
  const run = prev.catch(() => {}).then(fn)
  repoLocks.set(key, run)
  try {
    return await run
  } finally {
    if (repoLocks.get(key) === run) repoLocks.delete(key)
  }
}

async function git(cwd: string, args: string[]) {
  const { stdout } = await pexec('git', ['-C', cwd, ...args], { maxBuffer: 1024 * 1024 * 64 })
  return stdout
}

export function normalizeWorktreeLocation(value?: string | null): WorktreeLocation {
  return value === 'central' ? 'central' : 'repo'
}

export function resolveWorktreeRoot(localPath: string | null, reposDir: string, location?: string | null): string {
  if (normalizeWorktreeLocation(location) === 'repo' && localPath) {
    return resolve(localPath, REPO_WORKTREES_DIR)
  }
  return resolve(reposDir)
}

export function resolveWorktreePath(localPath: string | null, reposDir: string, taskId: string, location?: string | null): string {
  return resolve(resolveWorktreeRoot(localPath, reposDir, location), taskId)
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!!rel && !rel.startsWith('..') && !rel.startsWith('/'))
}

// With the worktree root inside the project repo, the main repo's `git status` lists it as a pile of
// untracked directories, and an agent running `git add -A` in the main repo risks committing it.
// Block that via .git/info/exclude (info/exclude is not versioned, so the project's shared .gitignore
// stays untouched).
// This does not stop IDEs from finding those worktrees: editors locate repos by scanning the file
// system, they don't read gitignore/exclude.
async function ensureRepoWorktreeExclude(localPath: string) {
  const excludePath = resolve(localPath, (await git(localPath, ['rev-parse', '--git-path', 'info/exclude'])).trim())
  if (!excludePath) return
  mkdirSync(dirname(excludePath), { recursive: true })
  const pattern = `/${REPO_WORKTREES_DIR}/`
  const body = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : ''
  if (body.split(/\r?\n/).some((line) => line.trim() === pattern)) return
  const prefix = body && !body.endsWith('\n') ? '\n' : ''
  appendFileSync(excludePath, `${prefix}${pattern}\n`)
}

export async function ensureWorktreeRoot(localPath: string, reposDir: string, location?: string | null): Promise<string> {
  const root = resolveWorktreeRoot(localPath, reposDir, location)
  mkdirSync(root, { recursive: true })
  if (normalizeWorktreeLocation(location) === 'repo' && isInside(resolve(localPath), root)) {
    // Failing to exclude only makes the main repo's git status a bit dirty; it shouldn't kill the
    // whole task → swallow the failure.
    await ensureRepoWorktreeExclude(localPath).catch(() => { /* non-fatal */ })
  }
  return root
}

// Remove a review's worktree (deregister from git + delete the directory). Called when a task is
// closed/deleted, to avoid leaking them.
export async function removeWorktree(
  localPath: string | null,
  reposDir: string,
  reviewId: string,
  opts: { location?: string | null; worktreePath?: string | null } = {},
) {
  const wtPath = resolve(opts.worktreePath || resolveWorktreePath(localPath, reposDir, reviewId, opts.location))
  if (localPath && existsSync(localPath)) {
    await withRepoLock(localPath, async () => {
      try {
        await git(localPath, ['worktree', 'remove', '--force', wtPath])
      } catch {
        /* not registered / already removed */
      }
    })
  }
  try {
    rmSync(wtPath, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

export async function migrateWorktreeToRepo(opts: {
  localPath: string | null
  reposDir: string
  taskId: string
  currentPath: string | null
  location?: string | null
}): Promise<string | null> {
  const { localPath, reposDir, taskId, currentPath, location } = opts
  if (normalizeWorktreeLocation(location) !== 'repo') return null
  if (!localPath || !currentPath || !existsSync(localPath) || !existsSync(currentPath)) return null
  const targetPath = resolveWorktreePath(localPath, reposDir, taskId, location)
  const oldPath = resolve(currentPath)
  if (oldPath === targetPath) {
    await ensureWorktreeRoot(localPath, reposDir, location)
    return null
  }
  if (existsSync(targetPath)) {
    throw new Error(`target worktree already exists: ${targetPath}`)
  }
  await ensureWorktreeRoot(localPath, reposDir, location)
  await withRepoLock(localPath, async () => {
    await git(localPath, ['worktree', 'move', oldPath, targetPath])
  })
  return targetPath
}

// For feature development: cut a **new feature branch** from the latest origin/<defaultBranch> and
// create a worktree for it (as opposed to review/fix, which check out an existing PR branch).
// -B = create if missing, reset to origin/default if it exists (safe to re-run).
export async function prepareFeatureWorktree(opts: {
  localPath: string
  reposDir: string
  taskId: string
  newBranch: string
  defaultBranch: string
  location?: string | null
  onStep?: (msg: string) => void
}): Promise<Worktree> {
  const { localPath, reposDir, taskId, newBranch, defaultBranch, onStep } = opts
  if (!localPath || !existsSync(localPath)) throw new Error(`项目未配置有效的本地 clone 路径：${localPath || '(空)'}`)
  if (!newBranch) throw new Error('新分支名为空')
  const wtPath = resolve(await ensureWorktreeRoot(localPath, reposDir, opts.location), taskId)

  const cleanup = async () => {
    await withRepoLock(localPath, async () => {
      try { await git(localPath, ['worktree', 'remove', '--force', wtPath]) } catch { /* already gone */ }
    })
  }

  const headSha = await withRepoLock(localPath, async () => {
    if (existsSync(wtPath)) {
      try { await git(localPath, ['worktree', 'remove', '--force', wtPath]) } catch { /* ignore */ }
    }
    // The worktree directory may have been wiped externally while the registration in .git/worktrees
    // remains → prune the stale entry, otherwise add fails with "already used".
    try { await git(localPath, ['worktree', 'prune']) } catch { /* ignore */ }

    onStep?.(`fetch origin ${defaultBranch}`)
    await git(localPath, ['fetch', 'origin', defaultBranch])

    // If the feature branch has already been pushed (PR was opened, worktree lost and needs restoring)
    // → rebuild from origin/<newBranch> so pushed commits are kept; otherwise a hard reset to
    // origin/default loses them, and the later open-pr push is rejected as non-fast-forward, leaving
    // the PR stuck and un-updatable.
    let baseRef = `origin/${defaultBranch}`
    const remote = await git(localPath, ['ls-remote', '--heads', 'origin', newBranch]).catch(() => '')
    if (remote.trim()) {
      try {
        await git(localPath, ['fetch', 'origin', newBranch])
        baseRef = `origin/${newBranch}`
      } catch { /* can't fetch it → fall back to default */ }
    }
    const sha = (await git(localPath, ['rev-parse', baseRef])).trim()
    onStep?.(`创建新分支 worktree（${newBranch} ← ${baseRef}）`)
    // -B: force-create/reset the feature branch to baseRef and check it out in the new worktree
    await git(localPath, ['worktree', 'add', '-B', newBranch, wtPath, baseRef])
    // For a new feature branch cut from origin/<default>, autoSetupMerge points its upstream at the
    // default branch. A bare `git push` (push.default=simple) is then rejected, and git's first
    // suggestion is to push to the default branch — an agent following it pushes feature commits
    // straight onto base, polluting the baseline and bypassing the PR. → Clear that misleading
    // upstream so a bare push instead prints the self-correcting
    // `--set-upstream origin <newBranch>` hint.
    // In the restore case (baseRef=origin/<newBranch>, same name) tracking is left alone, so push
    // updates the PR branch normally.
    if (baseRef === `origin/${defaultBranch}`) {
      await git(wtPath, ['branch', '--unset-upstream']).catch(() => { /* no upstream set → ignore */ })
    }
    return sha
  })

  return { path: wtPath, headSha, cleanup }
}

export type Worktree = { path: string; headSha: string; cleanup: () => Promise<void> }

// Open an isolated worktree on the project's existing local clone: fetch the PR branch → detached
// checkout → merge the default branch. Read-only in effect, never touching the main working tree.
// Returns the worktree path + a cleanup function.
export async function prepareWorktree(opts: {
  localPath: string
  reposDir: string
  reviewId: string
  branch: string
  defaultBranch: string
  // Review merges the default branch before looking at the diff; fix has to push, so pass false to
  // skip the merge → the commits that get pushed stay clean.
  mergeDefault?: boolean
  // Eval replay: check out this exact commit instead of the branch tip (fetched via refs/pull/<prNumber>/head when the
  // branch no longer carries it).
  checkoutSha?: string | null
  prNumber?: number | null
  location?: string | null
  onStep?: (msg: string) => void
}): Promise<Worktree> {
  const { localPath, reposDir, reviewId, branch, defaultBranch, onStep } = opts
  const mergeDefault = opts.mergeDefault !== false
  if (!localPath || !existsSync(localPath)) {
    throw new Error(`项目未配置有效的本地 clone 路径：${localPath || '(空)'}`)
  }
  // Without a branch, `git rev-parse origin/${branch}` would become `origin/` → an unreadable git error.
  // Fail early with a clear message instead (the caller must supply/resolve the branch upstream).
  if (!branch) {
    throw new Error('PR 分支为空，无法准备 worktree（PR 元数据缺失或分支已删除）')
  }
  const wtPath = resolve(await ensureWorktreeRoot(localPath, reposDir, opts.location), reviewId)

  // Cleanup goes through the repo lock too (worktree remove also touches .git/worktrees)
  const cleanup = async () => {
    await withRepoLock(localPath, async () => {
      try {
        await git(localPath, ['worktree', 'remove', '--force', wtPath])
      } catch {
        /* already gone → ignore */
      }
    })
  }

  // Serialize the preparation git operations (fetch + worktree add) per repo, so concurrent runs
  // don't fight over refs
  const headSha = await withRepoLock(localPath, async () => {
    if (existsSync(wtPath)) {
      try {
        await git(localPath, ['worktree', 'remove', '--force', wtPath])
      } catch {
        /* ignore */
      }
    }
    if (opts.checkoutSha) {
      onStep?.(`fetch ${branch} @ ${opts.checkoutSha.slice(0, 7)}`)
      try {
        await git(localPath, ['fetch', 'origin', branch, defaultBranch])
      } catch (e) {
        if (!opts.prNumber) throw e
        await git(localPath, ['fetch', 'origin', `refs/pull/${opts.prNumber}/head`, defaultBranch])
      }
      try {
        await git(localPath, ['cat-file', '-e', `${opts.checkoutSha}^{commit}`])
      } catch {
        // The branch moved on (force-push / rebase) or was deleted: GitHub still serves the PR head ref.
        if (opts.prNumber) await git(localPath, ['fetch', 'origin', `refs/pull/${opts.prNumber}/head`])
      }
      const sha = (await git(localPath, ['rev-parse', `${opts.checkoutSha}^{commit}`])).trim()
      onStep?.('创建 worktree')
      await git(localPath, ['worktree', 'add', '--detach', wtPath, sha])
      return sha
    }
    onStep?.(`fetch origin ${branch}`)
    let ref = `origin/${branch}`
    try {
      await git(localPath, ['fetch', 'origin', branch, defaultBranch])
    } catch (e) {
      // The branch is gone from the remote (merged + deleted): GitHub still serves the PR head under refs/pull/<n>/head.
      if (!opts.prNumber) throw e
      onStep?.(`分支已不在远端，改用 refs/pull/${opts.prNumber}/head`)
      await git(localPath, ['fetch', 'origin', `+refs/pull/${opts.prNumber}/head:refs/remotes/origin/pr/${opts.prNumber}`, defaultBranch])
      ref = `origin/pr/${opts.prNumber}`
    }
    const sha = (await git(localPath, ['rev-parse', ref])).trim()

    onStep?.('创建 worktree')
    // Detached at the PR head, to avoid clashing with a branch already checked out in the main repo
    await git(localPath, ['worktree', 'add', '--detach', wtPath, ref])
    return sha
  })

  // The merge happens inside each worktree (no contention on the main repo's refs), so it can run
  // concurrently — keep it outside the lock
  if (mergeDefault) {
    onStep?.(`merge origin/${defaultBranch}`)
    try {
      await git(wtPath, ['merge', '--no-edit', `origin/${defaultBranch}`])
    } catch (e) {
      onStep?.('merge 冲突，改用 PR head 原样审核')
      try {
        await git(wtPath, ['merge', '--abort'])
      } catch {
        /* ignore */
      }
    }
  }

  return { path: wtPath, headSha, cleanup }
}

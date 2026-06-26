import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync, existsSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

const pexec = promisify(execFile)

// 每个本地仓库一把互斥锁：并发审核会对同一个 .git 跑 git fetch / worktree add，
// 同时更新 refs/remotes/origin/* 会撞 "cannot lock ref"。同仓库的 git 准备串行化。
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

// 删除某个 review 的 worktree（git 注销 + 删目录）。task 关闭/删除时调用，避免泄漏。
export async function removeWorktree(localPath: string | null, reposDir: string, reviewId: string) {
  const wtPath = resolve(reposDir, reviewId)
  if (localPath && existsSync(localPath)) {
    await withRepoLock(localPath, async () => {
      try {
        await pexec('git', ['-C', localPath, 'worktree', 'remove', '--force', wtPath])
      } catch {
        /* 未注册/已删 */
      }
    })
  }
  try {
    rmSync(wtPath, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

async function git(cwd: string, args: string[]) {
  const { stdout } = await pexec('git', ['-C', cwd, ...args], { maxBuffer: 1024 * 1024 * 64 })
  return stdout
}

// Feature 开发用：从最新 origin/<defaultBranch> 拉一个**新功能分支**并建 worktree（区别于审核/修复的
// 「checkout 已有 PR 分支」）。-B = 不存在则建、存在则重置到 origin/default（重跑安全）。
export async function prepareFeatureWorktree(opts: {
  localPath: string
  reposDir: string
  taskId: string
  newBranch: string
  defaultBranch: string
  onStep?: (msg: string) => void
}): Promise<Worktree> {
  const { localPath, reposDir, taskId, newBranch, defaultBranch, onStep } = opts
  if (!localPath || !existsSync(localPath)) throw new Error(`项目未配置有效的本地 clone 路径：${localPath || '(空)'}`)
  if (!newBranch) throw new Error('新分支名为空')
  if (!existsSync(reposDir)) mkdirSync(reposDir, { recursive: true })
  const wtPath = resolve(reposDir, taskId)

  const cleanup = async () => {
    await withRepoLock(localPath, async () => {
      try { await git(localPath, ['worktree', 'remove', '--force', wtPath]) } catch { /* 已不存在 */ }
    })
  }

  const headSha = await withRepoLock(localPath, async () => {
    if (existsSync(wtPath)) {
      try { await git(localPath, ['worktree', 'remove', '--force', wtPath]) } catch { /* ignore */ }
    }
    onStep?.(`fetch origin ${defaultBranch}`)
    await git(localPath, ['fetch', 'origin', defaultBranch])
    const sha = (await git(localPath, ['rev-parse', `origin/${defaultBranch}`])).trim()
    onStep?.(`创建新分支 worktree（${newBranch} ← origin/${defaultBranch}）`)
    // -B：从 origin/default 强制建/重置功能分支，并在新 worktree 里 checkout
    await git(localPath, ['worktree', 'add', '-B', newBranch, wtPath, `origin/${defaultBranch}`])
    return sha
  })

  return { path: wtPath, headSha, cleanup }
}

export type Worktree = { path: string; headSha: string; cleanup: () => Promise<void> }

// 在项目已有本地 clone 上开一个隔离 worktree：fetch PR 分支 → detached checkout → merge 默认分支。
// 全程只读性质，不动主工作目录。返回 worktree 路径 + 清理函数。
export async function prepareWorktree(opts: {
  localPath: string
  reposDir: string
  reviewId: string
  branch: string
  defaultBranch: string
  // 审核默认 merge 默认分支再看 diff；「修复」要 push，传 false 不 merge → 推上去的提交才干净。
  mergeDefault?: boolean
  onStep?: (msg: string) => void
}): Promise<Worktree> {
  const { localPath, reposDir, reviewId, branch, defaultBranch, onStep } = opts
  const mergeDefault = opts.mergeDefault !== false
  if (!localPath || !existsSync(localPath)) {
    throw new Error(`项目未配置有效的本地 clone 路径：${localPath || '(空)'}`)
  }
  // Sans branche, `git rev-parse origin/${branch}` deviendrait `origin/` → erreur git illisible.
  // On échoue tôt avec un message clair (l'appelant doit fournir/résoudre la branche en amont).
  if (!branch) {
    throw new Error('PR 分支为空，无法准备 worktree（PR 元数据缺失或分支已删除）')
  }
  if (!existsSync(reposDir)) mkdirSync(reposDir, { recursive: true })
  const wtPath = resolve(reposDir, reviewId)

  // 清理也走仓库锁（worktree remove 也动 .git/worktrees）
  const cleanup = async () => {
    await withRepoLock(localPath, async () => {
      try {
        await git(localPath, ['worktree', 'remove', '--force', wtPath])
      } catch {
        /* 已不存在则忽略 */
      }
    })
  }

  // 准备阶段的 git 操作（fetch + worktree add）对同一仓库串行化，避免并发抢 ref
  const headSha = await withRepoLock(localPath, async () => {
    if (existsSync(wtPath)) {
      try {
        await git(localPath, ['worktree', 'remove', '--force', wtPath])
      } catch {
        /* ignore */
      }
    }
    onStep?.(`fetch origin ${branch}`)
    await git(localPath, ['fetch', 'origin', branch, defaultBranch])
    const sha = (await git(localPath, ['rev-parse', `origin/${branch}`])).trim()

    onStep?.('创建 worktree')
    // detached 在 PR head，避免与主仓已 checkout 的分支冲突
    await git(localPath, ['worktree', 'add', '--detach', wtPath, `origin/${branch}`])
    return sha
  })

  // merge 在各自 worktree 内进行（不抢主仓 refs），可并发，放锁外
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

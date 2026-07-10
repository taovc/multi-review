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
    // worktree 目录可能被外部清掉但 .git/worktrees 里登记还在 → prune 清陈旧登记，否则 add 会报「already used」。
    try { await git(localPath, ['worktree', 'prune']) } catch { /* ignore */ }

    onStep?.(`fetch origin ${defaultBranch}`)
    await git(localPath, ['fetch', 'origin', defaultBranch])

    // 功能分支若已推到远端（PR 开过、worktree 丢了要恢复）→ 基于 origin/<newBranch> 重建，保留已推送的提交；
    // 否则硬重置到 origin/default 会丢已推提交，且之后 open-pr 的 push 非快进被拒、卡死无法更新 PR。
    let baseRef = `origin/${defaultBranch}`
    const remote = await git(localPath, ['ls-remote', '--heads', 'origin', newBranch]).catch(() => '')
    if (remote.trim()) {
      try {
        await git(localPath, ['fetch', 'origin', newBranch])
        baseRef = `origin/${newBranch}`
      } catch { /* 拉不到就退回 default */ }
    }
    const sha = (await git(localPath, ['rev-parse', baseRef])).trim()
    onStep?.(`创建新分支 worktree（${newBranch} ← ${baseRef}）`)
    // -B：强制建/重置功能分支到 baseRef，并在新 worktree 里 checkout
    await git(localPath, ['worktree', 'add', '-B', newBranch, wtPath, baseRef])
    // 从 origin/<default> 建的新功能分支：autoSetupMerge 会把它的 upstream 设成默认分支。
    // 那样裸 `git push`（push.default=simple）会被拒，且 git 首条建议是 push 到默认分支——
    // agent 照做就把功能提交直接推上了 base，污染基线并绕过 PR。→ 清掉这个误导性 upstream，
    // 让裸 push 转而给出可自纠的 `--set-upstream origin <newBranch>` 提示。
    // 恢复场景（baseRef=origin/<newBranch>，同名）保留跟踪不动，push 正常更新 PR 分支。
    if (baseRef === `origin/${defaultBranch}`) {
      await git(wtPath, ['branch', '--unset-upstream']).catch(() => { /* 没设 upstream 就忽略 */ })
    }
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

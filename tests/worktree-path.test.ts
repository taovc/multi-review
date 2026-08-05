import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ensureWorktreeRoot, migrateWorktreeToRepo, resolveWorktreePath } from '../core/git/worktree'

const WT_DIR = '.pr-cockpit-worktrees'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
}

const root = mkdtempSync(join(tmpdir(), 'pr-cockpit-worktree-path-'))
const repo = join(root, 'repo')
const legacyRoot = join(root, 'legacy-worktrees')
const legacyPath = join(legacyRoot, 'task-1')

try {
  mkdirSync(repo, { recursive: true })
  mkdirSync(legacyRoot, { recursive: true })
  git(repo, ['init', '-q'])
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'Test User'])
  writeFileSync(join(repo, 'README.md'), 'hello\n')
  git(repo, ['add', 'README.md'])
  git(repo, ['commit', '-q', '-m', 'init'])
  git(repo, ['worktree', 'add', legacyPath, '-b', 'task-1', 'HEAD'])

  assert.equal(
    resolveWorktreePath(repo, legacyRoot, 'task-2', 'repo'),
    resolve(repo, WT_DIR, 'task-2'),
  )
  assert.equal(resolveWorktreePath(repo, legacyRoot, 'task-2', 'central'), resolve(legacyRoot, 'task-2'))

  const migrated = await migrateWorktreeToRepo({
    localPath: repo,
    reposDir: legacyRoot,
    taskId: 'task-1',
    currentPath: legacyPath,
    location: 'repo',
  })

  assert.equal(migrated, resolve(repo, WT_DIR, 'task-1'))
  assert.equal(existsSync(legacyPath), false)
  assert.equal(existsSync(migrated!), true)
  assert.equal(git(migrated!, ['status', '--short', '--branch']).startsWith('## task-1'), true)

  // repo 模式：worktree 根被写进 .git/info/exclude → 主仓库 status 保持干净，
  // agent 在主仓库跑 `git add -A` 不会把整坨 worktree 卷进提交。
  const excludePath = join(repo, '.git', 'info', 'exclude')
  const excludeBody = readFileSync(excludePath, 'utf8')
  assert.equal(excludeBody.split(/\r?\n/).filter((l) => l.trim() === `/${WT_DIR}/`).length, 1)
  assert.equal(git(repo, ['status', '--short']).trim(), '')

  // 重复调用不重复写入（每次建 worktree 都会走一遍）
  await ensureWorktreeRoot(repo, legacyRoot, 'repo')
  assert.equal(readFileSync(excludePath, 'utf8'), excludeBody)

  // central 模式：worktree 根在仓库外，不该往人家 .git/info/exclude 里塞东西
  const otherRepo = join(root, 'other-repo')
  mkdirSync(otherRepo, { recursive: true })
  git(otherRepo, ['init', '-q'])
  await ensureWorktreeRoot(otherRepo, legacyRoot, 'central')
  const otherExclude = join(otherRepo, '.git', 'info', 'exclude')
  const otherBody = existsSync(otherExclude) ? readFileSync(otherExclude, 'utf8') : ''
  assert.equal(otherBody.includes(WT_DIR), false)
} finally {
  rmSync(root, { recursive: true, force: true })
}

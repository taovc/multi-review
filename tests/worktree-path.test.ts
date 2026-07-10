import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { migrateWorktreeToRepo, resolveWorktreePath } from '../core/git/worktree'

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
    resolve(repo, 'pr-cockpit-worktrees', 'task-2'),
  )
  assert.equal(resolveWorktreePath(repo, legacyRoot, 'task-2', 'central'), resolve(legacyRoot, 'task-2'))

  const migrated = await migrateWorktreeToRepo({
    localPath: repo,
    reposDir: legacyRoot,
    taskId: 'task-1',
    currentPath: legacyPath,
    location: 'repo',
  })

  assert.equal(migrated, resolve(repo, 'pr-cockpit-worktrees', 'task-1'))
  assert.equal(existsSync(legacyPath), false)
  assert.equal(existsSync(migrated!), true)
  assert.match(git(repo, ['status', '--short']), /\?\? pr-cockpit-worktrees\//)
  assert.equal(git(migrated!, ['status', '--short', '--branch']).startsWith('## task-1'), true)
} finally {
  rmSync(root, { recursive: true, force: true })
}

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const pexec = promisify(execFile)
const MAX_DIFF = 400_000

const git = (wt: string, args: string[]) =>
  pexec('git', ['-C', wt, ...args], { maxBuffer: 64 * 1024 * 1024 })

// Definition of "fix changes" (last changes): only what this fix itself changed —
// not the whole PR (that's the main card's PR vs base), and not the changes a merge-base pulled in from the base branch.
//   - working tree has uncommitted changes → the current working-tree diff (including untracked new files)
//   - otherwise → walk first-parent to the most recent non-merge commit (skipping merge commits created by merge-base) and take its diff
type Range = { kind: 'worktree' } | { kind: 'commit'; sha: string } | { kind: 'none' }

async function resolveRange(wt: string): Promise<Range> {
  const { stdout: porcelain } = await git(wt, ['status', '--porcelain'])
  if (porcelain.trim()) return { kind: 'worktree' }
  const { stdout } = await git(wt, ['rev-list', '--first-parent', '--no-merges', '-n', '1', 'HEAD']).catch(() => ({ stdout: '' }))
  const sha = stdout.trim()
  return sha ? { kind: 'commit', sha } : { kind: 'none' }
}

function sumNumstat(out: string) {
  let filesChanged = 0
  let additions = 0
  let deletions = 0
  for (const line of out.trim().split('\n').filter(Boolean)) {
    const [a, d] = line.split('\t')
    filesChanged++
    additions += Number(a) || 0 // binary files report '-', count as 0
    deletions += Number(d) || 0
  }
  return { filesChanged, additions, deletions }
}

// `git diff HEAD` doesn't see untracked new files, so pick them up one by one with --no-index (read-only, doesn't touch the index).
// --no-index exits with code 1 when there is a difference, but stdout still holds the content → read it from the catch.
async function untracked(wt: string): Promise<{ diff: string; numstat: string }> {
  const { stdout } = await git(wt, ['ls-files', '--others', '--exclude-standard']).catch(() => ({ stdout: '' }))
  const files = stdout.split('\n').map((s) => s.trim()).filter(Boolean)
  let diff = ''
  let numstat = ''
  for (const f of files) {
    const dr = await git(wt, ['diff', '--no-index', '/dev/null', f]).catch((e: any) => ({ stdout: e?.stdout || '' }))
    diff += dr.stdout
    const nr = await git(wt, ['diff', '--no-index', '--numstat', '/dev/null', f]).catch((e: any) => ({ stdout: e?.stdout || '' }))
    numstat += nr.stdout
  }
  return { diff, numstat }
}

// "Something to upload" check: dirty working tree (uncommitted changes, including untracked files), or local HEAD ahead of origin/<branch>
// (committed but not pushed, including commits Claude made or merged itself). The latter can't rely on fixHeadSha in the DB —
// the chat no longer updates it, and Claude has full git access and commits on its own, so the DB value goes stale.
export async function hasUploadable(wt: string, branch: string | null): Promise<{ dirty: boolean; ahead: boolean }> {
  const { stdout: porcelain } = await git(wt, ['status', '--porcelain']).catch(() => ({ stdout: '' }))
  const dirty = !!porcelain.trim()
  let ahead = false
  if (branch) {
    const { stdout } = await git(wt, ['rev-list', '--count', `origin/${branch}..HEAD`]).catch(() => ({ stdout: '0' }))
    ahead = (Number(stdout.trim()) || 0) > 0
  }
  return { dirty, ahead }
}

// File count + added/removed lines (for the status line / confirmation dialog, no full diff text needed)
export async function fixChangesStat(wt: string): Promise<{ filesChanged: number; additions: number; deletions: number }> {
  const r = await resolveRange(wt)
  if (r.kind === 'none') return { filesChanged: 0, additions: 0, deletions: 0 }
  if (r.kind === 'worktree') {
    const { stdout } = await git(wt, ['diff', '--numstat', 'HEAD'])
    const u = await untracked(wt)
    return sumNumstat(stdout + u.numstat)
  }
  const { stdout } = await git(wt, ['show', '--numstat', '--format=', r.sha])
  return sumNumstat(stdout)
}

// Full diff text (for the "changes" tab)
export async function fixChangesDiff(wt: string): Promise<{ diff: string; truncated: boolean }> {
  const r = await resolveRange(wt)
  if (r.kind === 'none') return { diff: '', truncated: false }
  let out = ''
  if (r.kind === 'worktree') {
    const { stdout } = await git(wt, ['diff', 'HEAD'])
    const u = await untracked(wt)
    out = stdout + u.diff
  } else {
    const { stdout } = await git(wt, ['show', '--format=', r.sha])
    out = stdout
  }
  if (out.length > MAX_DIFF) return { diff: out.slice(0, MAX_DIFF), truncated: true }
  return { diff: out, truncated: false }
}

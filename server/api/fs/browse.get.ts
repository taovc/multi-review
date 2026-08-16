import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const pexec = promisify(execFile)

// Local tool: browse directories on the server's filesystem, used by "pick a local clone path".
// Only subdirectories are returned (no files, no dot-prefixed hidden directories), flagged with which ones are git repos.
// If the current directory is a git repo, its origin remote is also resolved → owner/repo (so project creation can prefill it).
interface Entry {
  name: string
  path: string
  isGit: boolean
}

async function isGitRepo(dir: string): Promise<boolean> {
  try {
    const st = await fs.stat(path.join(dir, '.git'))
    return st.isDirectory() || st.isFile() // a .git directory, or the .git file inside a worktree
  } catch {
    return false
  }
}

// git@github.com:owner/repo.git / https://github.com/owner/repo(.git) → owner/repo
function parseRemote(url: string): string | null {
  const m = url.trim().match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/)
  return m ? `${m[1]}/${m[2]}` : null
}

async function gitRemote(dir: string): Promise<string | null> {
  try {
    const { stdout } = await pexec('git', ['-C', dir, 'remote', 'get-url', 'origin'], { timeout: 4000 })
    return parseRemote(stdout)
  } catch {
    return null
  }
}

export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const raw = typeof q.path === 'string' ? q.path.trim() : ''
  const home = os.homedir()

  // Empty → the user's home directory; the ~ prefix is supported; everything is normalized to an absolute path.
  let target = raw ? (raw.startsWith('~') ? path.join(home, raw.slice(1)) : raw) : home
  target = path.resolve(target)

  let st
  try {
    st = await fs.stat(target)
  } catch (e: any) {
    const code = e?.code === 'EACCES' ? 403 : 404
    throw createError({ statusCode: code, statusMessage: `无法访问：${target}` })
  }

  // A file was passed in → fall back to its containing directory.
  if (!st.isDirectory()) target = path.dirname(target)

  let names: string[]
  try {
    names = await fs.readdir(target)
  } catch (e: any) {
    const code = e?.code === 'EACCES' ? 403 : 404
    throw createError({ statusCode: code, statusMessage: `无法读取目录：${target}` })
  }

  const entries: Entry[] = []
  for (const name of names) {
    if (name.startsWith('.')) continue // hidden directories are not shown
    const full = path.join(target, name)
    try {
      const s = await fs.stat(full)
      if (!s.isDirectory()) continue
      entries.push({ name, path: full, isGit: await isGitRepo(full) })
    } catch {
      // No permission / broken link, skip
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))

  // Whether the current directory is itself a git repo + its owner/repo (used to prefill the repo field).
  const currentIsGit = await isGitRepo(target)
  const repo = currentIsGit ? await gitRemote(target) : null

  const parent = path.dirname(target)
  return {
    path: target,
    parent: parent === target ? null : parent, // at the filesystem root, parent === target
    home,
    currentIsGit,
    repo,
    entries,
  }
})

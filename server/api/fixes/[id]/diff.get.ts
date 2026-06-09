import { eq } from 'drizzle-orm'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { schema } from '~core/db/client'

const pexec = promisify(execFile)
const MAX_DIFF = 400_000

// Diff des commits de fix (base PR head .. HEAD local) dans le worktree.
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const d = db()
  const fix = d.select().from(schema.fixes).where(eq(schema.fixes.id, id)).get()
  if (!fix) throw createError({ statusCode: 404, statusMessage: 'fix 不存在' })
  if (!fix.worktreePath || !fix.baseHeadSha) return { diff: '', truncated: false }
  try {
    const { stdout } = await pexec('git', ['-C', fix.worktreePath, 'diff', `${fix.baseHeadSha}..HEAD`], { maxBuffer: 64 * 1024 * 1024 })
    if (stdout.length > MAX_DIFF) return { diff: stdout.slice(0, MAX_DIFF), truncated: true }
    return { diff: stdout, truncated: false }
  } catch (e) {
    throw createError({ statusCode: 500, statusMessage: (e as Error).message })
  }
})

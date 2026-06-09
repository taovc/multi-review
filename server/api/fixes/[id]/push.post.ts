import { eq } from 'drizzle-orm'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { schema } from '~core/db/client'
import { removeWorktree } from '~core/git/worktree'

const pexec = promisify(execFile)

// Pousse les commits de fix sur la branche de la PR (après validation utilisateur), puis nettoie le worktree.
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const cfg = useRuntimeConfig()
  const d = db()
  const fix = d.select().from(schema.fixes).where(eq(schema.fixes.id, id)).get()
  if (!fix) throw createError({ statusCode: 404, statusMessage: 'fix 不存在' })
  if (fix.status !== 'ready') throw createError({ statusCode: 409, statusMessage: '该修复未就绪' })
  if (!fix.worktreePath || !fix.fixHeadSha) throw createError({ statusCode: 400, statusMessage: '缺少本地提交' })
  if ((fix.filesChanged ?? 0) === 0) throw createError({ statusCode: 400, statusMessage: '没有可推送的改动' })

  const now = () => new Date().toISOString()
  d.update(schema.fixes).set({ status: 'pushing', updatedAt: now() }).where(eq(schema.fixes.id, id)).run()
  try {
    await pexec('git', ['-C', fix.worktreePath, 'push', 'origin', `HEAD:${fix.branch}`], { maxBuffer: 64 * 1024 * 1024 })
  } catch (e: any) {
    const msg = String(e?.stderr || e?.message || '').slice(0, 400)
    d.update(schema.fixes).set({ status: 'error', error: msg, updatedAt: now() }).where(eq(schema.fixes.id, id)).run()
    throw createError({ statusCode: 500, statusMessage: msg })
  }
  d.update(schema.fixes).set({ status: 'pushed', pushedAt: now(), updatedAt: now() }).where(eq(schema.fixes.id, id)).run()

  const project = d.select().from(schema.projects).where(eq(schema.projects.id, fix.projectId)).get()
  await removeWorktree(project?.localPath ?? null, cfg.reposDir as string, id)
  return { ok: true, status: 'pushed' }
})

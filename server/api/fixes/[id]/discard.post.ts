import { eq } from 'drizzle-orm'
import { schema } from '~core/db/client'
import { removeWorktree } from '~core/git/worktree'

// Abandonne un fix prêt (ou en erreur) : nettoie le worktree et marque discarded.
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const cfg = useRuntimeConfig()
  const d = db()
  const fix = d.select().from(schema.fixes).where(eq(schema.fixes.id, id)).get()
  if (!fix) throw createError({ statusCode: 404, statusMessage: 'fix 不存在' })
  if (['queued', 'running', 'pushing'].includes(fix.status)) {
    throw createError({ statusCode: 409, statusMessage: '修复进行中，请等它完成' })
  }

  const project = d.select().from(schema.projects).where(eq(schema.projects.id, fix.projectId)).get()
  await removeWorktree(project?.localPath ?? null, cfg.reposDir as string, id)
  d.update(schema.fixes).set({ status: 'discarded', worktreePath: null, updatedAt: new Date().toISOString() }).where(eq(schema.fixes.id, id)).run()
  return { ok: true, status: 'discarded' }
})

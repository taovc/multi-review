import { eq } from 'drizzle-orm'
import { existsSync } from 'node:fs'
import { z } from 'zod'
import { schema } from '~core/db/client'
import { isRunBusy, runSessionTurn } from '~core/runs/session'
import { buildSessionTurnCtx, getRunOr404 } from '../../../utils/runContext'

// Send one message to a session run (fire-and-forget; progress streams on /api/runs/:id/stream). A cwd run may
// carry a new working directory (the /cd command), validated and persisted before the turn.
const Body = z.object({
  message: z.string().min(1).max(20000),
  cwd: z.string().optional(),
  allowDanger: z.boolean().optional(),
  ultracode: z.boolean().optional(),
  permissionMode: z.enum(['default', 'acceptEdits', 'plan', 'bypassPermissions']).optional(),
  projectId: z.string().optional(), // cwd runs: which project's defaults to follow before a native session exists
})

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const b = Body.parse((await readBody(event)) || {})
  const d = db()
  let run: any = getRunOr404(id)
  if (isRunBusy(id)) throw createError({ statusCode: 409, statusMessage: '上一条还在生成中，请等它完成或停止' })
  if (run.busyAction === 'pushing') throw createError({ statusCode: 409, statusMessage: '上传进行中，请等它完成' })
  if (run.workspaceType === 'cwd') {
    const cwd = b.cwd?.trim()
    if (cwd) {
      if (!existsSync(cwd)) throw createError({ statusCode: 400, statusMessage: `目录不存在: ${cwd}` })
      d.update(schema.runs).set({ workspacePath: cwd, updatedAt: new Date().toISOString() }).where(eq(schema.runs.id, id)).run()
      run = getRunOr404(id)
    } else if (!run.workspacePath) {
      throw createError({ statusCode: 400, statusMessage: '这个会话还没有工作目录（用 /cd <路径> 设置）' })
    }
  }
  const ctx = buildSessionTurnCtx(event, run, { message: b.message, permissionMode: b.permissionMode, allowDanger: b.allowDanger, ultracode: b.ultracode, projectId: b.projectId })
  void runSessionTurn(ctx).catch((e) => console.error('[runs] turn failed', e))
  return { ok: true, cwd: run.workspacePath }
})

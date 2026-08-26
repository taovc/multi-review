import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { schema } from '~core/db/client'
import { hostFor, hostOf } from '~core/host'
import { isRunBusy } from '~core/runs/session'
import { getRunOr404 } from '../../../utils/runContext'

// Rewind the workspace's tracked files to their state right before a user message (Claude Code file checkpoints).
// The session is resumed first when it idled out; the conversation itself is not rewound — only the files.
const Body = z.object({ turnId: z.string(), dryRun: z.boolean().optional() })

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const b = Body.parse((await readBody(event)) || {})
  const run = getRunOr404(id)
  if (run.provider !== 'claude') throw createError({ statusCode: 400, statusMessage: '文件回退只有 Claude 会话支持' })
  if (isRunBusy(id)) throw createError({ statusCode: 409, statusMessage: '对话进行中，请等它完成或停止' })
  const turn = db().select().from(schema.runTurns).where(eq(schema.runTurns.id, b.turnId)).get()
  if (!turn || turn.runId !== id || turn.role !== 'user') throw createError({ statusCode: 404, statusMessage: '消息不存在' })
  if (!turn.messageUuid) throw createError({ statusCode: 400, statusMessage: '这条消息没有文件快照（回退功能之前的会话）' })
  if (!run.workspacePath) throw createError({ statusCode: 400, statusMessage: '会话没有工作目录' })
  // The live query owns the checkpoints; resume it when it idled out.
  if (hostOf(id).status(id) === 'closed') {
    await hostFor('claude').ensure({ runId: id, kind: 'session', cwd: run.workspacePath, model: run.model ?? undefined, effort: run.effort ?? undefined, resume: run.claudeSessionId, permissionMode: (run.permissionMode as any) ?? undefined, db: db(), schema })
  }
  const r = await hostOf(id).rewindFiles(id, turn.messageUuid, !!b.dryRun)
  if (!r.canRewind) throw createError({ statusCode: 409, statusMessage: r.error || '无法回退' })
  return { ok: true, dryRun: !!b.dryRun, filesChanged: r.filesChanged ?? [], insertions: r.insertions ?? 0, deletions: r.deletions ?? 0 }
})

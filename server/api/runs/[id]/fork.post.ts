import { nanoid } from 'nanoid'
import { schema } from '~core/db/client'
import { isRunBusy } from '~core/runs/session'
import { getRunOr404 } from '../../../utils/runContext'

// Fork a working-directory session: a new run that continues from the source's transcript (Claude forkSession /
// Codex thread/fork on its first turn) without touching the source. Worktree sessions are not forkable — two
// conversations editing one worktree would fight over it.
export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')!
  const src = getRunOr404(id)
  if (src.workspaceType !== 'cwd') throw createError({ statusCode: 400, statusMessage: '只有工作目录会话可以 fork' })
  if (isRunBusy(id)) throw createError({ statusCode: 409, statusMessage: '对话进行中，请等它完成再 fork' })
  if (!src.claudeSessionId && !src.codexThreadId) throw createError({ statusCode: 400, statusMessage: '会话还没有内容可以 fork' })
  const now = new Date().toISOString()
  const newId = nanoid()
  db().insert(schema.runs).values({
    id: newId, kind: 'session', subkind: 'session', provider: src.provider, model: src.model, effort: src.effort, codexServiceTier: src.codexServiceTier,
    projectId: src.projectId, workspaceType: 'cwd', workspacePath: src.workspacePath, lang: src.lang,
    title: src.title ? `${src.title} (fork)` : null, permissionMode: src.permissionMode, allowDanger: src.allowDanger,
    // The source's native ids ride along until the fork's own session exists (core/runs/session.ts passes fork: true).
    claudeSessionId: src.provider === 'claude' ? src.claudeSessionId : null, codexThreadId: src.provider === 'codex' ? src.codexThreadId : null, forkedFrom: src.id,
    status: 'idle', createdAt: now, updatedAt: now,
  }).run()
  return { id: newId }
})

import { schema } from '~core/db/client'
import { cancelQueuedTurn } from '~core/runs/session'
import { getRunOr404 } from '../../../../utils/runContext'

// Withdraw a message that is still waiting for the running turn to finish.
export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')!
  const turnId = getRouterParam(event, 'turnId')!
  getRunOr404(id)
  const ok = cancelQueuedTurn(id, turnId, db(), schema)
  if (!ok) throw createError({ statusCode: 409, statusMessage: '这条消息已经开始或不在队列里' })
  return { ok: true }
})

import { stopReview } from '~core/agent/reviewAborts'

// Stop a running review / guided re-review / recheck: aborts the agent query; the job records `stopped`.
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  if (!stopReview(id)) throw createError({ statusCode: 409, statusMessage: '没有正在运行的审核' })
  return { ok: true }
})

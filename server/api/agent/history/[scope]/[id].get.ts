import { schema } from '~core/db/client'
import { buildAgentHistoryMarkdown, validateAgentHistoryToken } from '~core/agent/historyAccess'

// Read-only session history for the agent (cross-provider handoff). The only scope is `run`; the token minted per
// turn must match the run id.
export default defineEventHandler(async (event) => {
  if (getRouterParam(event, 'scope') !== 'run') throw createError({ statusCode: 404, statusMessage: 'history scope not found' })
  const id = getRouterParam(event, 'id') || ''
  const query = getQuery(event)
  const token = typeof query.token === 'string' ? query.token : undefined
  if (!validateAgentHistoryToken(id, token)) {
    throw createError({ statusCode: 403, statusMessage: 'invalid or expired history token' })
  }

  const rawLimit = typeof query.limit === 'string' ? Number(query.limit) : undefined
  const markdown = await buildAgentHistoryMarkdown({ db: db(), schema, id, limit: rawLimit })
  if (query.format === 'md') {
    setHeader(event, 'content-type', 'text/markdown; charset=utf-8')
    return markdown
  }
  return { scope: 'run', id, markdown }
})

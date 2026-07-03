import { z } from 'zod'
import { schema } from '~core/db/client'
import { buildAgentHistoryMarkdown, validateAgentHistoryToken, type AgentHistoryScope } from '~core/agent/historyAccess'

const Scope = z.enum(['fix', 'feature', 'global'])

export default defineEventHandler(async (event) => {
  const parsedScope = Scope.safeParse(getRouterParam(event, 'scope'))
  if (!parsedScope.success) throw createError({ statusCode: 404, statusMessage: 'history scope not found' })
  const scope = parsedScope.data as AgentHistoryScope
  const id = getRouterParam(event, 'id') || ''
  const query = getQuery(event)
  const token = typeof query.token === 'string' ? query.token : undefined
  if (!validateAgentHistoryToken(scope, id, token)) {
    throw createError({ statusCode: 403, statusMessage: 'invalid or expired history token' })
  }

  const rawLimit = typeof query.limit === 'string' ? Number(query.limit) : undefined
  const markdown = await buildAgentHistoryMarkdown({ db: db(), schema, scope, id, limit: rawLimit })
  if (query.format === 'md') {
    setHeader(event, 'content-type', 'text/markdown; charset=utf-8')
    return markdown
  }
  return { scope, id, markdown }
})

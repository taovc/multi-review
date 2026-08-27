import { eq } from 'drizzle-orm'
import { schema } from '~core/db/client'
import { getAgentSettings } from '~core/agent/settings'
import { agentConfigReport } from '~core/host/config'

// Agent configuration transparency. ?projectId= picks the cwd (the project's local clone), otherwise the server's cwd.
// ?probe=0 skips starting the CLI (files + settings only); ?refresh=1 bypasses the 5-minute probe cache.
export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const d = db()
  let cwd = process.cwd()
  if (typeof q.projectId === 'string' && q.projectId) {
    const p = d.select().from(schema.projects).where(eq(schema.projects.id, q.projectId)).get()
    if (!p) throw createError({ statusCode: 404, statusMessage: '项目不存在' })
    if (!p.localPath) throw createError({ statusCode: 400, statusMessage: '项目未配置本地 clone 路径' })
    cwd = p.localPath
  }
  return agentConfigReport({ cwd, agent: getAgentSettings(d, schema), probe: q.probe !== '0', refresh: q.refresh === '1' })
})

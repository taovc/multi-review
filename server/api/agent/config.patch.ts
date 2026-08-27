import { z } from 'zod'
import { schema } from '~core/db/client'
import { setAgentSettings } from '~core/agent/settings'

const Body = z.object({ chrome: z.boolean().optional(), reviewMcpAllow: z.array(z.string().min(1).max(100)).max(50).optional() })

// Global agent switches (Claude in Chrome for sessions, read-only MCP allow list for reviews).
export default defineEventHandler(async (event) => {
  const body = Body.parse((await readBody(event)) || {})
  return setAgentSettings(db(), schema, body)
})

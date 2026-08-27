import { z } from 'zod'
import { schema } from '~core/db/client'
import { setAgentSettings } from '~core/agent/settings'

const Body = z.object({ chrome: z.boolean().optional(), reviewMcp: z.boolean().optional() })

// Global agent switches (Claude in Chrome, MCP for the read-only review family).
export default defineEventHandler(async (event) => {
  const body = Body.parse((await readBody(event)) || {})
  return setAgentSettings(db(), schema, body)
})

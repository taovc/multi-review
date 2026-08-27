import { eq } from 'drizzle-orm'

// Global (project-independent) agent settings, stored in the `meta` table. Edited on the agent-config screen.
export type AgentSettings = {
  chrome: boolean // start Claude Code with --chrome so the Claude in Chrome MCP server comes up (sessions; reviews too when reviewMcp is on)
  reviewMcp: boolean // let the read-only review family connect and call the user's MCP servers (off = none connected)
}

const KEYS = { chrome: 'agent.chrome', reviewMcp: 'agent.reviewMcp' } as const

function readKey(db: any, schema: any, key: string): string | null {
  try { return db.select().from(schema.meta).where(eq(schema.meta.key, key)).get()?.value ?? null } catch { return null }
}

export function getAgentSettings(db: any, schema: any): AgentSettings {
  const chrome = readKey(db, schema, KEYS.chrome)
  return { chrome: chrome == null ? process.env.PR_COCKPIT_CHROME === '1' : chrome === '1', reviewMcp: readKey(db, schema, KEYS.reviewMcp) === '1' }
}

export function setAgentSettings(db: any, schema: any, patch: Partial<AgentSettings>): AgentSettings {
  const put = (key: string, value: string) => db.insert(schema.meta).values({ key, value }).onConflictDoUpdate({ target: schema.meta.key, set: { value } }).run()
  if (typeof patch.chrome === 'boolean') put(KEYS.chrome, patch.chrome ? '1' : '0')
  if (typeof patch.reviewMcp === 'boolean') put(KEYS.reviewMcp, patch.reviewMcp ? '1' : '0')
  return getAgentSettings(db, schema)
}

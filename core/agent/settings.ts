import { eq } from 'drizzle-orm'

// Global (project-independent) agent settings, stored in the `meta` table. Edited on the agent-config screen.
export type AgentSettings = {
  chrome: boolean // pass --chrome to sessions so Claude in Chrome connects
  reviewMcpAllow: string[] // MCP servers the read-only review family may call
}

const KEYS = { chrome: 'agent.chrome', reviewMcpAllow: 'agent.reviewMcpAllow' } as const

function readKey(db: any, schema: any, key: string): string | null {
  try { return db.select().from(schema.meta).where(eq(schema.meta.key, key)).get()?.value ?? null } catch { return null }
}

export function getAgentSettings(db: any, schema: any): AgentSettings {
  const chrome = readKey(db, schema, KEYS.chrome)
  let allow: string[] = []
  try { const v = JSON.parse(readKey(db, schema, KEYS.reviewMcpAllow) || '[]'); if (Array.isArray(v)) allow = v.map(String) } catch { /* keep [] */ }
  return { chrome: chrome == null ? process.env.PR_COCKPIT_CHROME === '1' : chrome === '1', reviewMcpAllow: allow }
}

export function setAgentSettings(db: any, schema: any, patch: Partial<AgentSettings>): AgentSettings {
  const put = (key: string, value: string) => db.insert(schema.meta).values({ key, value }).onConflictDoUpdate({ target: schema.meta.key, set: { value } }).run()
  if (typeof patch.chrome === 'boolean') put(KEYS.chrome, patch.chrome ? '1' : '0')
  if (Array.isArray(patch.reviewMcpAllow)) put(KEYS.reviewMcpAllow, JSON.stringify(patch.reviewMcpAllow.map(String)))
  return getAgentSettings(db, schema)
}

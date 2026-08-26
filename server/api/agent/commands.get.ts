import { eq } from 'drizzle-orm'
import { existsSync } from 'node:fs'
import { z } from 'zod'
import { schema } from '~core/db/client'
import { getAgentSettings } from '~core/agent/settings'
import { probeAgent } from '~core/host/config'
import { classifyCommands, codexSkillEntries, type CommandEntry } from '~core/host/commands'
import { describeCodexConfig } from '~core/codex/describe'

// The slash-command catalogue for a session composer: what the CLI would load for this directory (cached probe,
// no turn run), classified for the palette; for Codex the skills the app-server reports. Available before a session
// exists and after it idled out — the live session's commands_changed push replaces it while the session is live.
const Query = z.object({ cwd: z.string().optional(), projectId: z.string().optional(), provider: z.enum(['claude', 'codex']).default('claude'), refresh: z.string().optional() })

export default defineEventHandler(async (event) => {
  const q = Query.parse(getQuery(event))
  const d = db()
  let cwd = q.cwd?.trim() || ''
  if (!cwd && q.projectId) cwd = d.select().from(schema.projects).where(eq(schema.projects.id, q.projectId)).get()?.localPath ?? ''
  if (!cwd || !existsSync(cwd)) cwd = process.cwd()
  let commands: CommandEntry[] = []
  let error: string | null = null
  if (q.provider === 'codex') {
    const r = await describeCodexConfig(cwd, q.refresh === '1')
    commands = codexSkillEntries(r.skills)
    error = r.error ?? null
  } else {
    const p = await probeAgent(cwd, getAgentSettings(d, schema).chrome, q.refresh === '1')
    commands = classifyCommands(p.commands)
    error = p.error
  }
  return { cwd, provider: q.provider, commands, error }
})

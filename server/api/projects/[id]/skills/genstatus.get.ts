import { and, desc, eq } from 'drizzle-orm'
import { schema } from '~core/db/client'

// Is a skill generation running for this project? The config tab asks on mount so it can re-attach to a generation
// that was started before a tab switch / page reload (the run itself lives server-side and records a `runs` row).
export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')!
  const r = db().select({ id: schema.runs.id, startedAt: schema.runs.startedAt }).from(schema.runs)
    .where(and(eq(schema.runs.kind, 'review'), eq(schema.runs.subkind, 'skillgen'), eq(schema.runs.projectId, id), eq(schema.runs.status, 'running')))
    .orderBy(desc(schema.runs.createdAt)).limit(1).get()
  return { running: !!r, runId: r?.id ?? null, startedAt: r?.startedAt ?? null }
})

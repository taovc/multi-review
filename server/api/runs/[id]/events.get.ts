import { and, asc, eq, gt } from 'drizzle-orm'
import { schema } from '~core/db/client'
import { claudeHost } from '~core/host/claudeHost'

// Persisted RunEvents of a run (for backfilling the UI after reload / reconnect) + the prompts still pending.
// ?afterSeq=N returns only newer events.
export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')!
  const afterSeq = Number(getQuery(event).afterSeq ?? 0) || 0
  const d = db()
  const run = d.select().from(schema.runs).where(eq(schema.runs.id, id)).get()
  if (!run) throw createError({ statusCode: 404, statusMessage: 'run not found' })
  const events = d.select().from(schema.runEvents)
    .where(afterSeq ? and(eq(schema.runEvents.runId, id), gt(schema.runEvents.seq, afterSeq)) : eq(schema.runEvents.runId, id))
    .orderBy(asc(schema.runEvents.seq)).all()
    .map((r) => ({ seq: r.seq, ts: r.ts, turnId: r.turnId, kind: r.kind, message: r.message, data: r.data ? JSON.parse(r.data) : null }))
  const pending = d.select().from(schema.permissionRequests)
    .where(and(eq(schema.permissionRequests.runId, id), eq(schema.permissionRequests.status, 'pending'))).all()
    .map((p) => ({ id: p.id, kind: p.kind, toolName: p.toolName, input: p.input ? JSON.parse(p.input) : null, suggestions: !!p.suggestions, title: p.title, description: p.description, createdAt: p.createdAt, live: claudeHost.pendingPrompts(id).some((x) => x.id === p.id) }))
  const info = claudeHost.info(id)
  return { run, events, pending, live: claudeHost.status(id), permissionMode: info.permissionMode ?? run.permissionMode ?? null, commands: info.init?.slashCommands ?? [], skills: info.init?.skills ?? [] }
})

import { and, asc, eq } from 'drizzle-orm'
import { schema } from '~core/db/client'
import { isGlobalChatting, isGlobalLive } from '~core/global/pipeline'
import { hostOf } from '~core/host'
import { pendingPromptsFor } from '~core/host/pending'

// Single-stage global session detail: the session row + its turns (ordered by ascending seq). Used when loading history / opening the drawer.
export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')!
  const d = db()
  const session = d.select().from(schema.globalSessions).where(eq(schema.globalSessions.id, id)).get()
  if (!session) throw createError({ statusCode: 404, statusMessage: 'session 不存在' })
  const turns = d
    .select()
    .from(schema.globalTurns)
    .where(eq(schema.globalTurns.sessionId, id))
    .orderBy(asc(schema.globalTurns.seq))
    .all()

  // Self-heal orphaned streaming turns: a streaming turn exists ⟺ one is running (the job synchronously takes the lock before creating the turn); the only exception is a dead process (restart/killed).
  // In that case wrap it up as stopped + put the session back to idle, so the frontend doesn't get stuck on "generating / stop does nothing".
  const last = turns[turns.length - 1] as any
  if (last && last.role === 'assistant' && last.status === 'streaming' && !isGlobalLive(id)) {
    d.update(schema.globalTurns).set({ status: 'stopped' }).where(eq(schema.globalTurns.id, last.id)).run()
    if (session.status === 'streaming') {
      d.update(schema.globalSessions).set({ status: 'idle' }).where(eq(schema.globalSessions.id, id)).run()
      ;(session as any).status = 'idle'
    }
    last.status = 'stopped'
  }
  // Host state: pending permission / question / plan prompts + the live session's mode and slash-command palette.
  const pending = pendingPromptsFor(d, schema, id)
  const info = hostOf(id).info(id)
  const run = d.select().from(schema.runs).where(eq(schema.runs.id, id)).get()
  return {
    session, turns, chatting: isGlobalChatting(id) || isGlobalLive(id),
    host: { live: hostOf(id).status(id), permissionMode: info.permissionMode ?? run?.permissionMode ?? null, allowDanger: run?.allowDanger ?? null, commands: info.init?.slashCommands ?? [], skills: info.init?.skills ?? [], model: info.init?.model ?? null },
    pending,
    run: run ? { costUsd: run.costUsd, costSource: run.costSource, inputTokens: run.inputTokens, outputTokens: run.outputTokens, numTurns: run.numTurns } : null,
  }
})

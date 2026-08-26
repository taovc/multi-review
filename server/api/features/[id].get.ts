import { asc, eq } from 'drizzle-orm'
import { schema } from '~core/db/client'
import { isFeatureBusy } from '~core/feature/pipeline'
import { hostOf } from '~core/host'
import { pendingPromptsFor } from '~core/host/pending'

// feature task detail: task + chat turns + run events. Self-heals orphaned streaming turns (so a restart/kill doesn't leave it stuck "in progress").
export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')!
  const d = db()
  const task = d.select().from(schema.featureTasks).where(eq(schema.featureTasks.id, id)).get()
  if (!task) throw createError({ statusCode: 404, statusMessage: 'feature 任务不存在' })
  const turns = d
    .select()
    .from(schema.featureTurns)
    .where(eq(schema.featureTurns.taskId, id))
    .orderBy(asc(schema.featureTurns.seq))
    .all()

  // Self-heal orphaned streaming turns: a streaming turn exists ⟺ something is running; the only
  // exception is a dead process (restart/kill) → mark it stopped and put the task back to working
  // (worktree changes are kept, you can keep chatting / open a PR). opened/error are left alone.
  const last = turns[turns.length - 1] as any
  if (last && last.role === 'assistant' && last.status === 'streaming' && !isFeatureBusy(id)) {
    d.update(schema.featureTurns).set({ status: 'stopped' }).where(eq(schema.featureTurns.id, last.id)).run()
    last.status = 'stopped'
    if (task.status !== 'opened' && task.status !== 'error') {
      d.update(schema.featureTasks).set({ status: 'working' }).where(eq(schema.featureTasks.id, id)).run()
      ;(task as any).status = 'working'
    }
  }

  const legacyEvents = d
    .select({ ts: schema.featureEvents.ts, kind: schema.featureEvents.kind, message: schema.featureEvents.message })
    .from(schema.featureEvents)
    .where(eq(schema.featureEvents.taskId, id))
    .orderBy(asc(schema.featureEvents.ts))
    .all()

  // Host state: pending permission / question / plan prompts + the live session's mode and slash-command palette.
  const pending = pendingPromptsFor(d, schema, id)
  const info = hostOf(id).info(id)
  const run = d.select().from(schema.runs).where(eq(schema.runs.id, id)).get()
  // Host-backed turns log their tool calls / prompts in run_events (RunEvents), not in the legacy event table.
  const hostEvents = d.select({ ts: schema.runEvents.ts, kind: schema.runEvents.kind, message: schema.runEvents.message }).from(schema.runEvents).where(eq(schema.runEvents.runId, id)).all().filter((e) => !!e.message)
  const events = [...legacyEvents, ...hostEvents].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
  return {
    task, turns, events, busy: isFeatureBusy(id),
    host: { live: hostOf(id).status(id), permissionMode: info.permissionMode ?? run?.permissionMode ?? null, allowDanger: run?.allowDanger ?? null, commands: info.init?.slashCommands ?? [], skills: info.init?.skills ?? [], model: info.init?.model ?? null },
    pending,
    run: run ? { costUsd: run.costUsd, costSource: run.costSource, inputTokens: run.inputTokens, outputTokens: run.outputTokens, numTurns: run.numTurns } : null,
  }
})

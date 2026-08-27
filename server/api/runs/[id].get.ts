import { asc, eq } from 'drizzle-orm'
import { existsSync } from 'node:fs'
import { schema } from '~core/db/client'
import { fixChangesStat, hasUploadable } from '~core/fix/changes'
import { computeFixNextStatus } from '~core/fix/status'
import { fixStatusOf, isRunBusy } from '~core/runs/session'
import { hostOf } from '~core/host'
import { pendingPromptsFor } from '~core/host/pending'
import { getRunOr404 } from '../../utils/runContext'

// Session run detail: the run row, its turns, the event log (host RunEvents with a message), host state and pending
// prompts, plus workspace facts (worktree on disk, uploadable changes, PR links).
function safeParse(s: string): unknown { try { return JSON.parse(s) } catch { return null } }

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const d = db()
  const run: any = getRunOr404(id)
  const project = run.projectId ? d.select().from(schema.projects).where(eq(schema.projects.id, run.projectId)).get() : null
  const turns = d.select().from(schema.runTurns).where(eq(schema.runTurns.runId, id)).orderBy(asc(schema.runTurns.seq)).all() as any[]

  // Self-heal: a streaming assistant turn with nothing running behind it belongs to a dead process → close it as stopped.
  const last = turns[turns.length - 1]
  const busy = isRunBusy(id)
  if (last && last.role === 'assistant' && last.status === 'streaming' && !busy && run.busyAction !== 'pushing') {
    d.update(schema.runTurns).set({ status: 'stopped', endedAt: new Date().toISOString() }).where(eq(schema.runTurns.id, last.id)).run()
    last.status = 'stopped'
    const patch: Record<string, unknown> = { status: run.status === 'running' || run.status === 'awaiting_input' ? 'stopped' : run.status, error: null, updatedAt: new Date().toISOString() }
    if (run.workspaceType === 'pr_worktree' && run.workspacePath && existsSync(run.workspacePath)) {
      const up = await hasUploadable(run.workspacePath, run.branch).catch(() => ({ dirty: false, ahead: false }))
      const next = computeFixNextStatus({ dirty: up.dirty, ahead: up.ahead, currentStatus: fixStatusOf(run) })
      patch.uploadState = next === 'ready' ? 'ready' : next === 'pushed' ? 'pushed' : 'none'
    }
    d.update(schema.runs).set(patch).where(eq(schema.runs.id, id)).run()
    Object.assign(run, patch)
  }

  const workspaceExists = !!run.workspacePath && existsSync(run.workspacePath)
  let hasUnpushed = run.workspaceType === 'pr_worktree' && !!run.fixHeadSha && run.fixHeadSha !== run.lastPushSha
  let stat = { filesChanged: 0, additions: 0, deletions: 0 }
  // Don't touch the worktree while a turn/upload holds it (git status would read a half-done state).
  if (run.workspaceType === 'pr_worktree' && workspaceExists && !busy && run.busyAction !== 'pushing') {
    const [up, s] = await Promise.all([
      hasUploadable(run.workspacePath, run.branch).catch(() => ({ dirty: false, ahead: false })),
      fixChangesStat(run.workspacePath).catch(() => stat),
    ])
    hasUnpushed = up.dirty || up.ahead
    stat = s
  }
  // Event log for the stream: tool calls/results, thinking, tasks, compaction, denials, notes and errors, with their payload
  // (bounded at write time) so the UI can render cards; text deltas were never persisted.
  const CARD_KINDS = new Set(['tool_use', 'tool_result', 'thinking', 'task', 'compaction', 'permission_denied', 'note', 'error'])
  const events = d.select({ seq: schema.runEvents.seq, ts: schema.runEvents.ts, turnId: schema.runEvents.turnId, kind: schema.runEvents.kind, message: schema.runEvents.message, data: schema.runEvents.data })
    .from(schema.runEvents).where(eq(schema.runEvents.runId, id)).orderBy(asc(schema.runEvents.seq)).all()
    .filter((e) => CARD_KINDS.has(e.kind) || !!e.message)
    .map((e) => ({ seq: e.seq, ts: e.ts, turnId: e.turnId, kind: e.kind, message: e.message, data: e.data ? safeParse(e.data) : null }))
  const pending = pendingPromptsFor(d, schema, id)
  const info = hostOf(id).info(id)
  const prUrl = run.prUrl || (project && run.prNumber ? `https://github.com/${project.repo}/pull/${run.prNumber}` : null)
  return {
    run: { ...run, fixStatus: run.workspaceType === 'pr_worktree' ? fixStatusOf(run) : null },
    project: project ? { id: project.id, name: project.name, repo: project.repo, defaultBranch: project.defaultBranch } : null,
    turns,
    events,
    busy,
    host: { live: hostOf(id).status(id), permissionMode: info.permissionMode ?? run.permissionMode ?? null, allowDanger: run.allowDanger ?? null, commands: info.init?.slashCommands ?? [], skills: info.init?.skills ?? [], model: info.init?.model ?? null },
    pending,
    summary: { costUsd: run.costUsd, costSource: run.costSource, inputTokens: run.inputTokens, outputTokens: run.outputTokens, numTurns: run.numTurns },
    workspace: {
      path: run.workspacePath, exists: workspaceExists, hasUnpushed, ...stat, prUrl,
      commitUrl: project && run.workspaceType === 'pr_worktree' && run.lastPushSha ? `https://github.com/${project.repo}/pull/${run.prNumber}/commits/${run.lastPushSha}` : null,
    },
  }
})

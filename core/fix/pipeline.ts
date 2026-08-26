import { nanoid } from 'nanoid'
import { eq } from 'drizzle-orm'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fetchIssueContext } from '../github/issueAssets'
import { prepareWorktree, removeWorktree } from '../git/worktree'
import { claudeChatRunner } from '../agent/claudeRunners'
import { codexChatRunner } from '../agent/codexChat'
import { hasUploadable } from './changes'
import { computeFixNextStatus } from './status'
import { appendTurns } from '../db/turns'
import { makeEmit } from '../streaming/emit'
import { sessionFields } from '../agent/session'
import { prepareAgentHistoryAccess } from '../agent/historyAccess'
import { fetchReviewsCount } from '../github/gh'
import { ensureSessionRun, finishRun, recordRunUsage } from '../runs/store'
import { claudeHost } from '../host/claudeHost'
import { runChannel } from '../host/recorder'
import { fixSystemPrompt } from '../agent/fixer'
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import type { ChildProcess } from 'node:child_process'
import type { ChatRunner, ReviewProvider } from '../agent/runners'

const pexec = promisify(execFile)
const git = (wt: string, args: string[]) => pexec('git', ['-C', wt, ...args], { maxBuffer: 64 * 1024 * 1024 })

// Fixing a PR = one always-on conversation: chat with the agent inside a git worktree of the PR branch and let it edit files directly (written to disk, not committed).
// The commit + push only happens when the user clicks "commit and upload" in the UI (see push.post.ts). There are no verification / batch-fix / merge-default-branch / reply-to-author stages.

export function selectChatRunner(provider?: ReviewProvider): ChatRunner {
  return provider === 'codex' ? codexChatRunner : claudeChatRunner
}

// Concurrency lock: taken the moment a job enters (before spawn), released only when the whole job ends.
// Use this to prevent concurrency rather than activeChats — the latter only exists once the child process is spawned and is emptied as soon as it exits, leaving a gap at both ends.
const chatLocks = new Set<string>()
// The real child-process handle (only after spawn), used by the stop button to kill.
const activeChats = new Map<string, ChildProcess>()
// The SDK runner has no child-process handle; interrupt it via the stop callback the runner exposes.
const activeChatStops = new Map<string, () => void>()
const stopRequested = new Set<string>() // stopped by the user → the job marks that turn stopped (not error)
export function isChatting(fixId: string): boolean {
  return chatLocks.has(fixId) || claudeHost.isBusy(fixId)
}
export function stopFixChat(fixId: string): boolean {
  // Host-backed (claude) turn: interrupt it, keep the session alive. A job that has not reached send() yet remembers the stop.
  if (claudeHost.isBusy(fixId)) { stopRequested.add(fixId); void claudeHost.interrupt(fixId); return true }
  if (chatLocks.has(fixId) && !activeChatStops.has(fixId) && !activeChats.has(fixId)) { stopRequested.add(fixId); return true }
  const stop = activeChatStops.get(fixId)
  if (stop) {
    stopRequested.add(fixId)
    stop()
    return true
  }
  const cp = activeChats.get(fixId)
  if (!cp || cp.pid == null) return false // still preparing the worktree (not spawned) or not running → no handle to kill
  stopRequested.add(fixId)
  const pid = cp.pid
  // The child process is started detached as a process-group leader → send SIGINT to the "whole group" (including processes it spawned), same as Ctrl+C.
  // Changes the agent already wrote to disk are kept, waiting for the user to upload.
  try { process.kill(-pid, 'SIGINT') } catch { try { cp.kill('SIGINT') } catch { /* already exited */ } }
  // Fallback: force-kill the whole group if it hasn't exited after 1.5s
  setTimeout(() => { try { process.kill(-pid, 'SIGKILL') } catch { /* already exited */ } }, 1500)
  return true
}

// On process exit (app closing) stop every running fix session (CLI process groups + SDK runners) so nothing is orphaned.
export function stopAllFixChats(): boolean {
  let any = false
  for (const id of new Set([...activeChats.keys(), ...activeChatStops.keys()])) any = stopFixChat(id) || any
  return any
}

// db/schema are injected by the caller (core does not depend on the runtime db directly).
export type FixJobCtx = {
  db: any
  schema: any
  fixId: string
  repo: string
  prNumber: number
  branch: string
  defaultBranch: string
  localPath: string
  reposDir: string
  worktreeLocation?: string | null
  provider?: ReviewProvider
  model: string // the real model of the current provider (never mixed)
  effort?: string
  codexServiceTier?: string | null
  lang: string
  allowDanger?: boolean // let commands past the dangerous-command guard (including git push / gh pr create); blocked by default
  permissionMode?: PermissionMode // claude host: default / acceptEdits / plan / bypassPermissions (fix defaults to bypassPermissions + danger guard)
  ultracode?: boolean // activate ultracode in the background (the prefix is injected by the runner)
  assetsDir: string // root directory for downloaded issue/PR images (unified image reading)
}

// ── Shared little helpers ──────────────────────────────────────────────
function helpers(ctx: FixJobCtx) {
  const { db, schema, fixId } = ctx
  const now = () => new Date().toISOString()
  // Events go on the realtime bus + into fix_events (to backfill the history log when the task is opened, same as the review drawer). Channel = the bare fixId.
  const emit = makeEmit({ channel: runChannel(fixId), now, db, eventTable: schema.fixEvents, fkField: 'fixId', fkValue: fixId })
  const row = () => db.select().from(schema.fixes).where(eq(schema.fixes.id, fixId)).get()
  return { now, emit, row }
}

// Worktree reuse: created on the first conversation and kept until push/discard; if it goes missing in between (restart cleanup, etc.) it is recreated from the same branch.
async function ensureWorktree(ctx: FixJobCtx, h: ReturnType<typeof helpers>) {
  const r = h.row()
  if (r?.worktreePath && existsSync(r.worktreePath)) {
    return { path: r.worktreePath as string, headSha: r.baseHeadSha as string }
  }
  const wt = await prepareWorktree({
    localPath: ctx.localPath,
    reposDir: ctx.reposDir,
    location: ctx.worktreeLocation,
    reviewId: ctx.fixId,
    branch: ctx.branch,
    defaultBranch: ctx.defaultBranch,
    mergeDefault: false, // a fix gets pushed, so don't merge the default branch → the commits we push stay clean
    onStep: (m) => h.emit('stage', m),
  })
  ctx.db.update(ctx.schema.fixes).set({ worktreePath: wt.path, baseHeadSha: wt.headSha, updatedAt: h.now() }).where(eq(ctx.schema.fixes.id, ctx.fixId)).run()
  return { path: wt.path, headSha: wt.headSha }
}

async function currentHead(wt: string): Promise<string | null> {
  const { stdout } = await git(wt, ['rev-parse', 'HEAD']).catch(() => ({ stdout: '' }))
  return stdout.trim() || null
}

async function conflictHint(wt: string): Promise<string | undefined> {
  const { stdout } = await git(wt, ['diff', '--name-only', '--diff-filter=U']).catch(() => ({ stdout: '' }))
  const files = stdout.trim().split('\n').map((s) => s.trim()).filter(Boolean)
  if (!files.length) return undefined
  return `There are UNRESOLVED merge conflicts in these files (they contain <<<<<<< / ======= / >>>>>>> markers): ${files.join(', ')}. Resolve every conflict by editing the files and removing all conflict markers.`
}

// ── Conversation: keep chatting inside the worktree and keep editing ──────────────────────────────
// Doesn't go through reviewQueue (interactive, runs immediately); only one chat at a time per fix (the endpoint blocks with isChatting).
export async function runFixChatJob(ctx: FixJobCtx, message: string): Promise<void> {
  const { db, schema, fixId } = ctx
  const h = helpers(ctx)

  // Concurrency lock: taken as soon as we enter the function (the endpoint already blocks with isChatting; this is the fallback against a race). Released only when the whole job ends.
  if (chatLocks.has(fixId)) return
  chatLocks.add(fixId)

  // Append-only turns: a user turn + an assistant placeholder turn (written to as the stream comes in)
  const { assistantId: asstId } = appendTurns({ db, turnTable: schema.fixTurns, fkField: 'fixId', fkValue: fixId, now: h.now, message })
  h.emit('chat', 'user')

  // Me stepping into the conversation = this round of review has been answered → at the start of the conversation raise the "reviews updated" baseline (reviewsAtPush) to the current review count, clearing the red dot.
  // Done at the start rather than the end: new reviews submitted during/after the conversation (the count keeps growing) will still light it up again.
  // Only fetch the count when we have already pushed (pushedAt set, the only case where reviewerUpdated can be true), to save a pointless network call.
  try {
    const fr = h.row()
    if (fr?.pushedAt) {
      const reviewsNow = await fetchReviewsCount(ctx.repo, ctx.prNumber).catch(() => null)
      if (reviewsNow != null) db.update(schema.fixes).set({ reviewsAtPush: reviewsNow, updatedAt: h.now() }).where(eq(schema.fixes.id, fixId)).run()
    }
  } catch { /* a failed fetch must not affect the conversation */ }

  let acc = ''
  let lastWrite = 0
  const flushTurn = (status: string) =>
    db.update(schema.fixTurns).set({ content: acc, status }).where(eq(schema.fixTurns.id, asstId)).run()

  try {
    try {
      const wt = await ensureWorktree(ctx, h)
      const fix = h.row()
      let stopped = false
      // Run record (id = fix id): one row per conversation, usage appended per turn.
      ensureSessionRun(db, schema, {
        id: fixId, kind: 'session', subkind: 'session', provider: ctx.provider === 'codex' ? 'codex' : 'claude',
        projectId: fix?.projectId ?? null, workspaceType: 'pr_worktree', workspacePath: wt.path, prNumber: ctx.prNumber, branch: ctx.branch,
        model: ctx.model, effort: ctx.effort, codexServiceTier: ctx.codexServiceTier, lang: ctx.lang, title: fix?.title ?? null,
      })
      // Image reading (unified): a GitHub issue/PR referenced in the reviewer's message → fetch the body + download the images (including private attachments, using the gh token) → feed in the paths.
      let agentMessage = message
      try {
        const ic = await fetchIssueContext(message, join(ctx.assetsDir, `fix-${fixId}`))
        if (ic) {
          agentMessage = `${message}\n\n[Content of the issue/PR referenced in the message (already fetched by the backend)]\n${ic.enrichedText}`
          if (ic.imagePaths.length) {
            agentMessage += `\n\n[Images (already downloaded locally — open each one with Read first)]\n${ic.imagePaths.map((p, i) => `${i + 1}. ${p}`).join('\n')}`
          }
          h.emit('stage', `已抓取 issue/PR 内容（${ic.summary}）`)
        }
      } catch (e) {
        h.emit('stage', `issue/PR 抓取失败，用原始消息继续：${(e as Error).message}`)
      }
      // Each provider stores its session in its own column: claude→session_id, codex→codex_session_id.
      // When the provider is switched each one resumes its own thread and never resumes with the other's id (avoids errors / crossed context / mixing).
      const saveSession = (sid: string | null) => sessionFields(ctx.provider, sid)
      const resumeId: string | null = (ctx.provider === 'codex' ? fix?.codexSessionId : fix?.sessionId) ?? null
      let newSessionId: string | null = resumeId
      const headBeforeCodex = ctx.provider === 'codex' ? await currentHead(wt.path) : null
      const historyAccess = await prepareAgentHistoryAccess({
        db, schema, scope: 'fix', id: fixId, cwd: wt.path, limit: 80,
      }).catch((e) => {
        h.emit('stage', `历史入口准备失败，继续本轮：${(e as Error).message}`)
        return undefined
      })
      try {
        if (ctx.provider === 'claude') {
          // Session host: one live query per fix; permission prompts / AskUserQuestion / plan approval surface as RunEvents.
          const needsHandoff = !!fix?.codexSessionId && !resumeId
          const text = `${ctx.ultracode ? 'ultracode: ' : ''}${agentMessage}${needsHandoff && historyAccess ? `\n\n${historyAccess}` : ''}`
          await claudeHost.ensure({
            runId: fixId, kind: 'session', cwd: wt.path, model: ctx.model, effort: ctx.effort, resume: resumeId,
            permissionMode: ctx.permissionMode ?? 'bypassPermissions', allowDanger: ctx.allowDanger, systemAppend: fixSystemPrompt(ctx.lang, await conflictHint(wt.path)),
            db, schema,
          })
          if (stopRequested.has(fixId)) throw new Error('stopped before the turn started')
          const r = await claudeHost.send(fixId, text, {
            turnId: asstId,
            onSessionId: (sessionId) => {
              newSessionId = sessionId
              db.update(schema.fixes).set({ ...saveSession(sessionId), updatedAt: h.now() }).where(eq(schema.fixes.id, fixId)).run()
            },
            onText: (t) => {
              acc += t
              const n = new Date().getTime()
              if (n - lastWrite > 400) { lastWrite = n; flushTurn('streaming') }
              h.emit('text', t)
            },
          })
          acc = r.text || acc
          newSessionId = r.sessionId ?? newSessionId
          recordRunUsage(db, schema, fixId, r.usage, asstId)
          if (r.usage?.costUsd != null) {
            const prev = h.row()?.costUsd ?? 0
            db.update(schema.fixes).set({ costUsd: prev + r.usage.costUsd }).where(eq(schema.fixes.id, fixId)).run()
          }
          if (r.interrupted || stopRequested.has(fixId)) stopped = true
          else if (r.isError) throw new Error(r.subtype === 'error_during_execution' ? (r.error || r.text || 'agent turn failed') : `agent turn ended: ${r.subtype}`)
        } else {
        const chatRunner = selectChatRunner(ctx.provider)
        const r = await chatRunner.runChat({
          cwd: wt.path,
          model: ctx.model,
          effort: ctx.effort,
          codexServiceTier: ctx.codexServiceTier,
          lang: ctx.lang,
          sessionId: resumeId,
          message: agentMessage,
          historyAccess,
          allowDanger: ctx.allowDanger,
          ultracode: ctx.ultracode,
          conflictHint: await conflictHint(wt.path),
          onSpawn: (cp) => activeChats.set(fixId, cp),
          onStop: (stop) => activeChatStops.set(fixId, stop),
          onSessionId: (sessionId) => {
            newSessionId = sessionId
            db.update(schema.fixes).set({ ...saveSession(sessionId), updatedAt: h.now() }).where(eq(schema.fixes.id, fixId)).run()
          },
          onTool: (name, info) => h.emit('tool', `${name} ${info}`), // tool call → tool event → live into the log + inline steps
          onText: (t) => {
            acc += t
            const n = new Date().getTime()
            if (n - lastWrite > 400) { lastWrite = n; flushTurn('streaming') } // throttled db writes
            h.emit('text', t) // pushed in full to the frontend for live streaming assembly (not persisted, see the text exclusion in emit)
          },
        })
        acc = r.text || acc
        newSessionId = r.sessionId ?? newSessionId
        recordRunUsage(db, schema, fixId, r.usage, asstId)
        if (r.usage?.costUsd != null) {
          const prev = h.row()?.costUsd ?? 0
          db.update(schema.fixes).set({ costUsd: prev + r.usage.costUsd }).where(eq(schema.fixes.id, fixId)).run()
        }
        if (ctx.provider === 'codex' && headBeforeCodex) {
          const headAfterCodex = await currentHead(wt.path)
          if (headAfterCodex && headAfterCodex !== headBeforeCodex) {
            throw new Error('Codex chat changed git HEAD. Codex must leave commits to the existing upload path; inspect the worktree before retrying.')
          }
        }
        }
      } catch (e) {
        if (stopRequested.has(fixId)) stopped = true // stopped by the user, not an error
        else throw e
      } finally {
        activeChats.delete(fixId)
        activeChatStops.delete(fixId)
        stopRequested.delete(fixId)
      }

      flushTurn(stopped ? 'stopped' : 'done')

      // No automatic commit: the agent's changes stay uncommitted in the worktree until the user clicks "commit and upload".
      // Uncommitted changes, or committed but not pushed → mark ready "pending upload" (visible at a glance in the list/drawer); otherwise stay open / stay pushed.
      // Only sessionId is updated so the next turn can resume; the change stats are computed live by [id].get via fixChangesStat from the worktree (including uncommitted changes).
      const up = await hasUploadable(wt.path, ctx.branch).catch(() => ({ dirty: false, ahead: false }))
      const cur = h.row()
      const nextStatus = computeFixNextStatus({ dirty: up.dirty, ahead: up.ahead, currentStatus: cur?.status })
      db.update(schema.fixes).set({ status: nextStatus, error: null, ...saveSession(newSessionId), updatedAt: h.now() }).where(eq(schema.fixes.id, fixId)).run()
      finishRun(db, schema, fixId, { status: stopped ? 'stopped' : 'idle' })
      h.emit('chat', stopped ? 'stopped' : 'done')
    } catch (e) {
      activeChats.delete(fixId)
      activeChatStops.delete(fixId)
      stopRequested.delete(fixId)
      flushTurn('error')
      const errMsg = (e as Error).message
      // Both providers behave the same on error: the fix is marked error and the message is persisted so it is visible (the turn is error too).
      // Changes already written to disk stay in the worktree, and the error state still allows uploading (UPLOADABLE includes error).
      db.update(schema.fixes).set({ status: 'error', error: errMsg, updatedAt: h.now() }).where(eq(schema.fixes.id, fixId)).run()
      finishRun(db, schema, fixId, { status: 'error', error: errMsg })
      h.emit('error', errMsg)
    }
  } finally {
    // The concurrency lock is only released here (once the whole job, db wrap-up included, is done), so a second chat can never squeeze in during the wrap-up
    chatLocks.delete(fixId)
    activeChats.delete(fixId)
    activeChatStops.delete(fixId)
    stopRequested.delete(fixId)
  }
}

// Clean up the worktree when the task is discarded / deleted
export async function cleanupFixWorktree(
  localPath: string | null,
  reposDir: string,
  fixId: string,
  opts: { worktreeLocation?: string | null; worktreePath?: string | null } = {},
) {
  await removeWorktree(localPath, reposDir, fixId, { location: opts.worktreeLocation, worktreePath: opts.worktreePath })
}

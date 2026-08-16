import { eq } from 'drizzle-orm'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { prepareFeatureWorktree } from '../git/worktree'
import { runFeatureChat } from '../agent/featureChat'
import { genFeatureTitle } from '../agent/featureTitle'
import { appendTurns } from '../db/turns'
import { makeEmit } from '../streaming/emit'
import { sessionFields } from '../agent/session'
import { prepareAgentHistoryAccess } from '../agent/historyAccess'
import { fetchIssueContext } from '../github/issueAssets'
import { findPrByBranch } from '../github/gh'
import type { ChildProcess } from 'node:child_process'
import type { ReviewProvider } from '../agent/runners'

// Feature development, single-phase (native agent): one task = a free-form development chat inside one
// isolated worktree (a new feature branch). No more "read-only plan → approve → implement" split; the agent
// works directly and asks the user with an ```ask-user block at real decision points (→ awaiting).
// When the user clicks "open a PR", the agent commits/pushes/opens the PR itself. After each turn we query gh
// by branch to sync the PR status. SSE channel f:<taskId>.
export const featureChan = (id: string) => `f:${id}`

// Marker that the agent is waiting on the user: the output contains an ```ask-user fenced block → this turn
// ends in "waiting for your confirmation".
const ASK_RE = /```ask-user\b/i
export function hasAskBlock(text: string): boolean {
  return ASK_RE.test(text || '')
}

const jobLocks = new Set<string>()
export function isFeatureBusy(id: string): boolean {
  return jobLocks.has(id)
}

// Stop state: featureStops = the abort callback exposed by the runner; activeFeatureChats = child process
// handles (for kill); featureStopRequested = the user stopped on purpose → mark that turn stopped, not error.
const activeFeatureChats = new Map<string, ChildProcess>()
const featureStopRequested = new Set<string>()
const featureStops = new Map<string, () => void>()

function slugify(s: string): string {
  return (s || 'feature').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'feature'
}

// Ensure the feature's isolated worktree (a new feature branch cut from origin/<default>). All development
// runs inside it — **never touch the user's real local clone**. Created on first use, reused afterwards;
// if it's gone, recreate it on the same branch.
// The branch name is slugified down to plain [a-z0-9-] so nanoid's `_` doesn't trip the SAFE_REF guard.
async function ensureFeatureWorktree(p: {
  db: any; schema: any; taskId: string
  localPath: string; reposDir: string; defaultBranch: string
  worktreeLocation?: string | null
  now: () => string; emit: (kind: string, message: string) => void
}): Promise<string> {
  const { db, schema, taskId } = p
  const t = db.select().from(schema.featureTasks).where(eq(schema.featureTasks.id, taskId)).get()
  if (t?.worktreePath && existsSync(t.worktreePath)) return t.worktreePath as string
  p.emit('stage', '准备 worktree（新功能分支）')
  const branch = t?.branch || `feat/${slugify(t?.title || t?.description)}-${slugify(taskId.slice(0, 6))}`
  const wt = await prepareFeatureWorktree({
    localPath: p.localPath, reposDir: p.reposDir, taskId,
    location: p.worktreeLocation,
    newBranch: branch, defaultBranch: t?.baseBranch || p.defaultBranch,
    onStep: (m) => p.emit('stage', m),
  })
  db.update(schema.featureTasks)
    .set({ worktreePath: wt.path, baseHeadSha: wt.headSha, branch, updatedAt: p.now() })
    .where(eq(schema.featureTasks.id, taskId))
    .run()
  return wt.path
}

export function stopFeatureImpl(taskId: string): boolean {
  const stop = featureStops.get(taskId)
  if (stop) { featureStopRequested.add(taskId); stop(); return true }
  const cp = activeFeatureChats.get(taskId)
  if (!cp || cp.pid == null) return false
  featureStopRequested.add(taskId)
  const pid = cp.pid
  try { process.kill(-pid, 'SIGINT') } catch { try { cp.kill('SIGINT') } catch { /* already exited */ } }
  setTimeout(() => { try { process.kill(-pid, 'SIGKILL') } catch { /* already exited */ } }, 1500)
  return true
}

// On process exit (app close), stop every running feature development (child process groups) so none are orphaned.
export function stopAllFeatureImpl(): boolean {
  let any = false
  for (const id of new Set([...activeFeatureChats.keys(), ...featureStops.keys()])) any = stopFeatureImpl(id) || any
  return any
}

export type FeatureDevelopJobCtx = {
  db: any
  schema: any
  taskId: string
  localPath: string
  reposDir: string
  worktreeLocation?: string | null
  defaultBranch: string
  repo: string // owner/name, used to query the PR back via gh
  provider: ReviewProvider
  model: string
  translateModel: string // cheap/fast model (used to generate the task title; follows the provider, same as assembleReview's translate)
  effort?: string
  codexServiceTier?: string | null
  lang: string
  allowDanger?: boolean // the user enabled "allow dangerous commands" / clicked "open a PR" → let dangerous commands past the guard (incl. git push / gh pr create)
  ultracode?: boolean // activate ultracode in the background; the stored message stays clean, the provider runner decides how to apply it
  assetsDir: string // root dir for downloaded issue/PR images (used when fetching the issue on the first turn)
}

// message = this turn's user input (first turn = the raw requirement; later = follow-up chat / decision answer / "open a PR for me").
export async function runFeatureDevelopJob(ctx: FeatureDevelopJobCtx, message: string): Promise<void> {
  const { db, schema, taskId } = ctx
  const now = () => new Date().toISOString()
  const emit = makeEmit({ channel: featureChan(taskId), now, db, eventTable: schema.featureEvents, fkField: 'taskId', fkValue: taskId })
  const task = () => db.select().from(schema.featureTasks).where(eq(schema.featureTasks.id, taskId)).get()
  const saveSession = (sid: string | null) => sessionFields(ctx.provider, sid)

  if (jobLocks.has(taskId)) return
  jobLocks.add(taskId)
  let asstId = ''
  let acc = ''
  let lastWrite = 0
  const flush = (status: string) => db.update(schema.featureTurns).set({ content: acc, status }).where(eq(schema.featureTurns.id, asstId)).run()

  try {
    // append-only: a user turn (clean message) + an assistant placeholder turn (filled in as the stream arrives).
    asstId = appendTurns({ db, turnTable: schema.featureTurns, fkField: 'taskId', fkValue: taskId, now, message }).assistantId
    db.update(schema.featureTasks).set({ status: 'working', error: null, updatedAt: now() }).where(eq(schema.featureTasks.id, taskId)).run()
    emit('chat', 'user')

    const t0 = task()
    const isFirstTurn = !(ctx.provider === 'codex' ? t0?.codexSessionId : t0?.sessionId)

    // The message sent to the agent (may be enriched/prefixed); what is stored/displayed stays the original clean message.
    let agentMessage = message
    let issueEnriched = '' // issue body fetched on the first turn; also fed into the "understand the requirement" title generation
    // First turn: fetch the issue/PR body + download images (the agent has no network and can't download images; done once).
    if (isFirstTurn) {
      try {
        const ic = await fetchIssueContext(`${t0?.description || ''}\n${message || ''}`, join(ctx.assetsDir, taskId))
        if (ic) {
          issueEnriched = ic.enrichedText
          agentMessage = `${message}\n\n[Issue/PR content related to this requirement (already fetched by the backend)]\n${ic.enrichedText}`
          if (ic.imagePaths.length) {
            agentMessage += `\n\n[Images (already downloaded locally — open each one with Read before you start working)]\n${ic.imagePaths.map((p, i) => `${i + 1}. ${p}`).join('\n')}`
          }
          emit('stage', `已抓取 issue/PR 内容（${ic.summary}）`)
        }
      } catch (e) {
        emit('stage', `issue/PR 抓取失败，用原始需求继续：${(e as Error).message}`)
      }
    }
    // First turn with no title yet: read the requirement and generate a one-line short title (cheap/fast model, async in the background so it doesn't block develop; on failure the list falls back to showing the description).
    if (isFirstTurn && !t0?.title) {
      void genFeatureTitle({ provider: ctx.provider, model: ctx.translateModel, requirement: `${t0?.description || message}\n${issueEnriched}`, lang: ctx.lang, cwd: ctx.localPath })
        .then((title) => { if (title) db.update(schema.featureTasks).set({ title, updatedAt: now() }).where(eq(schema.featureTasks.id, taskId)).run() })
        .catch(() => { /* generation failure is fine, the list falls back to showing the description */ })
    }
    // The ultracode prefix is injected by the shared runner (chat.ts / runCodexChat) based on the flag; not assembled here.

    // Ensure the new-branch worktree (created on the first turn, reused afterwards). Never touch the real local clone.
    const wtPath = await ensureFeatureWorktree({
      db, schema, taskId, localPath: ctx.localPath, reposDir: ctx.reposDir, worktreeLocation: ctx.worktreeLocation, defaultBranch: ctx.defaultBranch, now, emit,
    })

    let stopped = false
    let newSessionId: string | null = (ctx.provider === 'codex' ? t0?.codexSessionId : t0?.sessionId) ?? null
    const historyAccess = await prepareAgentHistoryAccess({
      db, schema, scope: 'feature', id: taskId, cwd: wtPath, limit: 80,
    }).catch((e) => {
      emit('stage', `历史入口准备失败，继续本轮：${(e as Error).message}`)
      return undefined
    })
    try {
      const cur = task()
      const r = await runFeatureChat(ctx.provider, {
        cwd: wtPath,
        model: ctx.model,
        effort: ctx.effort,
        codexServiceTier: ctx.codexServiceTier,
        lang: ctx.lang,
        sessionId: (ctx.provider === 'codex' ? cur?.codexSessionId : cur?.sessionId) ?? null,
        message: agentMessage,
        historyAccess,
        allowDanger: ctx.allowDanger,
        ultracode: ctx.ultracode, // the prefix is injected by the runner
        baseBranch: cur?.baseBranch || ctx.defaultBranch, // used as gh pr create --base when opening the PR

        onSpawn: (cp) => activeFeatureChats.set(taskId, cp),
        onStop: (stop) => featureStops.set(taskId, stop),
        onSessionId: (sid) => {
          newSessionId = sid
          db.update(schema.featureTasks).set({ ...saveSession(sid), updatedAt: now() }).where(eq(schema.featureTasks.id, taskId)).run()
        },
        onTool: (n, i) => emit('tool', `${n} ${i}`),
        onText: (t2) => {
          acc += t2
          const n = new Date().getTime()
          if (n - lastWrite > 400) { lastWrite = n; flush('streaming') }
          emit('text', t2)
        },
      })
      acc = r.text || acc
      newSessionId = r.sessionId ?? newSessionId
    } catch (e) {
      if (featureStopRequested.has(taskId)) stopped = true
      else throw e
    } finally {
      activeFeatureChats.delete(taskId)
      featureStops.delete(taskId)
      featureStopRequested.delete(taskId)
    }

    flush(stopped ? 'stopped' : 'done')

    // Wrap-up: querying the PR back and "waiting on you" are decoupled — the agent may open a PR and ask a question in the same turn, so handle both.
    // ① Only query gh when a PR could exist (dangerous commands were allowed this turn / a PR was opened before) — skips a round trip that would always be null;
    //    if found, sync prUrl/prNumber. `opened` is naturally sticky because the PR stays on GitHub, so later question turns don't lose it.
    // ② badge: the agent is waiting on you → awaiting (prUrl is still recorded, the link isn't lost); else a PR exists → opened; else working.
    const cur = task()
    let prPatch: Record<string, unknown> = {}
    let prOpened = !!cur?.prUrl
    if (cur?.branch && (ctx.allowDanger || cur?.prUrl)) {
      const pr = await findPrByBranch(ctx.repo, cur.branch).catch(() => null)
      if (pr?.url) { prPatch = { prUrl: pr.url, prNumber: pr.number || null }; prOpened = true }
    }
    const nextStatus = (!stopped && hasAskBlock(acc)) ? 'awaiting' : (prOpened ? 'opened' : 'working')
    db.update(schema.featureTasks)
      .set({ status: nextStatus, error: null, ...prPatch, ...saveSession(newSessionId), updatedAt: now() })
      .where(eq(schema.featureTasks.id, taskId))
      .run()
    emit('chat', stopped ? 'stopped' : 'done')
  } catch (e) {
    activeFeatureChats.delete(taskId)
    featureStops.delete(taskId)
    featureStopRequested.delete(taskId)
    flush('error')
    const errMsg = (e as Error).message
    db.update(schema.featureTasks).set({ status: 'error', error: errMsg, updatedAt: now() }).where(eq(schema.featureTasks.id, taskId)).run()
    emit('error', errMsg)
  } finally {
    jobLocks.delete(taskId)
    activeFeatureChats.delete(taskId)
    featureStops.delete(taskId)
    featureStopRequested.delete(taskId)
  }
}

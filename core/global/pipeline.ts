import { eq } from 'drizzle-orm'
import { join } from 'node:path'
import { appendTurns } from '../db/turns'
import { makeEmit } from '../streaming/emit'
import { globalSystemPrompt } from '../agent/globalChat'
import { sessionFields } from '../agent/session'
import { prepareAgentHistoryAccess } from '../agent/historyAccess'
import { fetchIssueContext } from '../github/issueAssets'
import { ensureSessionRun, finishRun, recordRunUsage } from '../runs/store'
import { hostFor, hostOf } from '../host'
import { runChannel } from '../host/recorder'
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import type { ReviewProvider } from '../agent/runners'

// A global session = one always-on "can do anything" conversation on the session hosts (core/host for Claude — a long-lived
// SDK query; core/codex for Codex — an app-server thread), both with native permission prompts / questions / interrupt.
// Image reading, ultracode and decision cards are shared. The SSE channel is `run:<sessionId>` — the host's RunEvents and
// this pipeline's own chat/stage/done/error events travel on the same channel.
export const globalChan = (id: string) => runChannel(id)

const chatLocks = new Set<string>()
const stopRequested = new Set<string>()

export function isGlobalChatting(id: string): boolean {
  return chatLocks.has(id)
}

export function stopGlobalChat(id: string): boolean {
  // Host-backed session: interrupt the current turn, keep the session alive. A job that holds the lock but has not
  // reached send() yet remembers the stop so the turn is skipped.
  const host = hostOf(id)
  if (host.isBusy(id)) { stopRequested.add(id); void host.interrupt(id); return true }
  if (chatLocks.has(id)) { stopRequested.add(id); return true }
  return false
}

export function stopAllGlobalChats(): boolean {
  let any = false
  for (const id of [...chatLocks]) any = stopGlobalChat(id) || any
  return any
}

export function isGlobalLive(id: string): boolean {
  return chatLocks.has(id) || hostOf(id).isBusy(id)
}

export type GlobalChatJobCtx = {
  db: any
  schema: any
  sessionId: string
  provider: ReviewProvider
  cwd: string
  model: string
  effort?: string // empty = default
  codexServiceTier?: string | null
  lang: string
  allowDanger?: boolean // the user turned on the "allow dangerous commands" switch → let them past the guard
  ultracode?: boolean // activate ultracode in the background (the prefix is injected by the runner)
  permissionMode?: PermissionMode // claude host: default / acceptEdits / plan / bypassPermissions
  chrome?: boolean // claude host: pass --chrome so Claude in Chrome connects
  assetsDir: string // root directory for downloaded issue/PR images
}

export async function runGlobalChatJob(ctx: GlobalChatJobCtx, message: string): Promise<void> {
  const { db, schema, sessionId } = ctx
  const now = () => new Date().toISOString()
  const emit = makeEmit({ channel: globalChan(sessionId), now }) // global doesn't persist events (no eventTable passed)
  const row = () => db.select().from(schema.globalSessions).where(eq(schema.globalSessions.id, sessionId)).get()
  const saveSession = (sid: string | null) => sessionFields(ctx.provider, sid)

  if (chatLocks.has(sessionId)) return
  chatLocks.add(sessionId)

  let asstId = ''
  let acc = ''
  let lastWrite = 0
  const flush = (status: string) =>
    db.update(schema.globalTurns).set({ content: acc, status }).where(eq(schema.globalTurns.id, asstId)).run()

  try {
    asstId = appendTurns({ db, turnTable: schema.globalTurns, fkField: 'sessionId', fkValue: sessionId, now, message }).assistantId
    db.update(schema.globalSessions).set({ status: 'streaming', lastUsedAt: now() }).where(eq(schema.globalSessions.id, sessionId)).run()
    emit('chat', 'user')

    // Image/issue reading (unified): a GitHub issue/PR referenced in the message → fetch the body + download the images (including private attachments, using the gh token) → feed in the paths.
    let agentMessage = message
    try {
      const ic = await fetchIssueContext(message, join(ctx.assetsDir, `g-${sessionId}`))
      if (ic) {
        agentMessage = `${message}\n\n[Content of the issue/PR referenced in the message (already fetched by the backend)]\n${ic.enrichedText}`
        if (ic.imagePaths.length) {
          agentMessage += `\n\n[Images (already downloaded locally — open each one with Read first)]\n${ic.imagePaths.map((p, i) => `${i + 1}. ${p}`).join('\n')}`
        }
        emit('stage', `已抓取 issue/PR 内容（${ic.summary}）`)
      }
    } catch (e) {
      emit('stage', `issue/PR 抓取失败，用原始消息继续：${(e as Error).message}`)
    }

    let stopped = false
    const cur = row()
    const resumeId: string | null = (ctx.provider === 'codex' ? cur?.codexSessionId : cur?.sessionId) ?? null
    let newSessionId: string | null = resumeId
    // Run record (id = session id): one row per global conversation, usage appended per turn.
    ensureSessionRun(db, schema, {
      id: sessionId, kind: 'session', subkind: 'session', provider: ctx.provider === 'codex' ? 'codex' : 'claude',
      workspaceType: 'cwd', workspacePath: ctx.cwd, model: ctx.model, effort: ctx.effort, codexServiceTier: ctx.codexServiceTier, lang: ctx.lang, title: cur?.title ?? null,
    })
    const historyAccess = await prepareAgentHistoryAccess({
      db, schema, scope: 'global', id: sessionId, cwd: ctx.cwd, limit: 80,
    }).catch((e) => {
      emit('stage', `历史入口准备失败，继续本轮：${(e as Error).message}`)
      return undefined
    })
    try {
      const onSessionId = (sid: string) => {
        newSessionId = sid
        db.update(schema.globalSessions).set({ ...saveSession(sid), lastUsedAt: now() }).where(eq(schema.globalSessions.id, sessionId)).run()
      }
      const onText = (t: string) => {
        acc += t
        const n = new Date().getTime()
        if (n - lastWrite > 400) { lastWrite = n; flush('streaming') }
        emit('text', t)
      }
      // Session host (Claude SDK query / Codex app-server thread): permission prompts / questions / plan approval surface as RunEvents.
      // The cross-provider history handoff is only needed when this session previously ran on the other provider.
      const host = hostFor(ctx.provider)
      const otherSession = ctx.provider === 'codex' ? cur?.sessionId : cur?.codexSessionId
      const needsHandoff = !!otherSession && !resumeId
      const text = `${ctx.ultracode && ctx.provider !== 'codex' ? 'ultracode: ' : ''}${agentMessage}${needsHandoff && historyAccess ? `\n\n${historyAccess}` : ''}`
      await host.ensure({
        runId: sessionId, kind: 'session', cwd: ctx.cwd, model: ctx.model, effort: ctx.effort, resume: resumeId,
        permissionMode: ctx.permissionMode ?? 'default', allowDanger: ctx.allowDanger, systemAppend: globalSystemPrompt(ctx.lang), chrome: ctx.chrome,
        codexServiceTier: ctx.codexServiceTier, ultracode: ctx.ultracode, guardScope: 'global',
        db, schema,
      })
      if (stopRequested.has(sessionId)) throw new Error('stopped before the turn started')
      const r = await host.send(sessionId, text, { turnId: asstId, onSessionId, onText })
      acc = r.text || acc
      newSessionId = r.sessionId ?? newSessionId
      recordRunUsage(db, schema, sessionId, r.usage, asstId)
      if (r.interrupted || stopRequested.has(sessionId)) stopped = true
      else if (r.isError) throw new Error(r.subtype === 'error_during_execution' ? (r.error || r.text || 'agent turn failed') : `agent turn ended: ${r.subtype}`)
    } catch (e) {
      if (stopRequested.has(sessionId)) stopped = true // stopped by the user, not an error
      else throw e
    } finally {
      stopRequested.delete(sessionId)
    }
    flush(stopped ? 'stopped' : 'done')
    const c2 = row()
    const title = c2?.title || message.trim().slice(0, 60)
    db.update(schema.globalSessions)
      .set({ ...saveSession(newSessionId), status: 'idle', error: null, title, lastUsedAt: now() })
      .where(eq(schema.globalSessions.id, sessionId))
      .run()
    finishRun(db, schema, sessionId, { status: stopped ? 'stopped' : 'idle' })
    emit('chat', stopped ? 'stopped' : 'done')
  } catch (e) {
    stopRequested.delete(sessionId)
    flush('error')
    const errMsg = (e as Error).message
    db.update(schema.globalSessions).set({ status: 'error', error: errMsg, lastUsedAt: now() }).where(eq(schema.globalSessions.id, sessionId)).run()
    finishRun(db, schema, sessionId, { status: 'error', error: errMsg })
    emit('error', errMsg)
  } finally {
    chatLocks.delete(sessionId)
    stopRequested.delete(sessionId)
  }
}

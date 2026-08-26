import { eq } from 'drizzle-orm'
import { join } from 'node:path'
import { appendTurns } from '../db/turns'
import { makeEmit } from '../streaming/emit'
import { runGlobalChat, globalSystemPrompt } from '../agent/globalChat'
import { sessionFields } from '../agent/session'
import { prepareAgentHistoryAccess } from '../agent/historyAccess'
import { fetchIssueContext } from '../github/issueAssets'
import { ensureSessionRun, finishRun, recordRunUsage } from '../runs/store'
import { claudeHost } from '../host/claudeHost'
import { runChannel } from '../host/recorder'
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import type { ChildProcess } from 'node:child_process'
import type { ReviewProvider } from '../agent/runners'

// A global session = one always-on "can do anything" conversation. Claude runs on the session host (core/host: a long-lived
// SDK query with native permission prompts / AskUserQuestion / plan mode / interrupt); Codex still goes through runCodexChat.
// Image reading, ultracode and decision cards are shared. The SSE channel is `run:<sessionId>` — the host's RunEvents and
// this pipeline's own chat/stage/done/error events travel on the same channel.
export const globalChan = (id: string) => runChannel(id)

const chatLocks = new Set<string>()
const activeChats = new Map<string, ChildProcess>()
const activeChatStops = new Map<string, () => void>() // abort handles for the codex runner
const stopRequested = new Set<string>()

export function isGlobalChatting(id: string): boolean {
  return chatLocks.has(id)
}

export function stopGlobalChat(id: string): boolean {
  // Host-backed (claude) session: interrupt the current turn, keep the session alive.
  if (claudeHost.isBusy(id)) { stopRequested.add(id); void claudeHost.interrupt(id); return true }
  // The job holds the lock but has not reached send() yet (still creating the query): remember the stop so the turn is skipped.
  if (chatLocks.has(id) && !activeChatStops.has(id) && !activeChats.has(id)) { stopRequested.add(id); return true }
  const stop = activeChatStops.get(id)
  const cp = activeChats.get(id)
  if (!stop && (!cp || cp.pid == null)) return false
  stopRequested.add(id)
  if (stop) {
    try { stop() } catch { /* already exited */ }
  }
  if (cp?.pid != null) {
    const pid = cp.pid
    try { process.kill(-pid, 'SIGINT') } catch { try { cp.kill('SIGINT') } catch { /* already exited */ } }
    setTimeout(() => { try { process.kill(-pid, 'SIGKILL') } catch { /* already exited */ } }, 1500)
  }
  return true
}

export function stopAllGlobalChats(): boolean {
  let any = false
  for (const id of new Set([...activeChats.keys(), ...activeChatStops.keys()])) any = stopGlobalChat(id) || any
  return any
}

export function isGlobalLive(id: string): boolean {
  return chatLocks.has(id) || claudeHost.isBusy(id)
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
      if (ctx.provider === 'claude') {
        // Session host: one live query per session; permission prompts / AskUserQuestion / plan approval surface as RunEvents.
        // The cross-provider history handoff is only needed when this session previously ran on Codex.
        const needsHandoff = !!cur?.codexSessionId && !resumeId
        const text = `${ctx.ultracode ? 'ultracode: ' : ''}${agentMessage}${needsHandoff && historyAccess ? `\n\n${historyAccess}` : ''}`
        await claudeHost.ensure({
          runId: sessionId, kind: 'session', cwd: ctx.cwd, model: ctx.model, effort: ctx.effort, resume: resumeId,
          permissionMode: ctx.permissionMode ?? 'default', allowDanger: ctx.allowDanger, systemAppend: globalSystemPrompt(ctx.lang), chrome: ctx.chrome,
          db, schema,
        })
        if (stopRequested.has(sessionId)) throw new Error('stopped before the turn started')
        const r = await claudeHost.send(sessionId, text, { turnId: asstId, onSessionId, onText })
        acc = r.text || acc
        newSessionId = r.sessionId ?? newSessionId
        recordRunUsage(db, schema, sessionId, r.usage, asstId)
        if (r.interrupted || stopRequested.has(sessionId)) stopped = true
        else if (r.isError) throw new Error(r.subtype === 'error_during_execution' ? (r.error || r.text || 'agent turn failed') : `agent turn ended: ${r.subtype}`)
      } else {
        const r = await runGlobalChat(ctx.provider, {
          cwd: ctx.cwd,
          model: ctx.model,
          effort: ctx.effort,
          codexServiceTier: ctx.codexServiceTier,
          lang: ctx.lang,
          sessionId: resumeId,
          message: agentMessage,
          historyAccess,
          allowDanger: ctx.allowDanger,
          ultracode: ctx.ultracode,
          onSpawn: (cp) => activeChats.set(sessionId, cp),
          onStop: (stop) => activeChatStops.set(sessionId, stop),
          onSessionId,
          onTool: (name, info) => emit('tool', `${name} ${info}`),
          onText,
        })
        acc = r.text || acc
        newSessionId = r.sessionId ?? newSessionId
        recordRunUsage(db, schema, sessionId, r.usage, asstId)
      }
    } catch (e) {
      if (stopRequested.has(sessionId)) stopped = true // stopped by the user, not an error
      else throw e
    } finally {
      activeChats.delete(sessionId)
      activeChatStops.delete(sessionId)
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
    activeChats.delete(sessionId)
    activeChatStops.delete(sessionId)
    stopRequested.delete(sessionId)
    flush('error')
    const errMsg = (e as Error).message
    db.update(schema.globalSessions).set({ status: 'error', error: errMsg, lastUsedAt: now() }).where(eq(schema.globalSessions.id, sessionId)).run()
    finishRun(db, schema, sessionId, { status: 'error', error: errMsg })
    emit('error', errMsg)
  } finally {
    chatLocks.delete(sessionId)
    activeChats.delete(sessionId)
    activeChatStops.delete(sessionId)
    stopRequested.delete(sessionId)
  }
}

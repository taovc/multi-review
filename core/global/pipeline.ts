import { eq } from 'drizzle-orm'
import { join } from 'node:path'
import { appendTurns } from '../db/turns'
import { makeEmit } from '../streaming/emit'
import { runGlobalChat } from '../agent/globalChat'
import { sessionFields } from '../agent/session'
import { prepareAgentHistoryAccess } from '../agent/historyAccess'
import { fetchIssueContext } from '../github/issueAssets'
import type { ChildProcess } from 'node:child_process'
import type { ReviewProvider } from '../agent/runners'

// 全局会话 = 一个常驻的「啥都能干」对话。和 feature/fix 统一：claude/codex 双 provider、图片读取、ultracode、
// 危险命令守卫、决策卡都走共享能力（chat.ts / runCodexChat）。SSE 频道用 `g:<sessionId>`。
export const globalChan = (id: string) => `g:${id}`

const chatLocks = new Set<string>()
const activeChats = new Map<string, ChildProcess>()
const activeChatStops = new Map<string, () => void>() // codex runner 的 abort 句柄
const stopRequested = new Set<string>()

export function isGlobalChatting(id: string): boolean {
  return chatLocks.has(id)
}

export function stopGlobalChat(id: string): boolean {
  const stop = activeChatStops.get(id)
  const cp = activeChats.get(id)
  if (!stop && (!cp || cp.pid == null)) return false
  stopRequested.add(id)
  if (stop) {
    try { stop() } catch { /* 已退出 */ }
  }
  if (cp?.pid != null) {
    const pid = cp.pid
    try { process.kill(-pid, 'SIGINT') } catch { try { cp.kill('SIGINT') } catch { /* 已退出 */ } }
    setTimeout(() => { try { process.kill(-pid, 'SIGKILL') } catch { /* 已退出 */ } }, 1500)
  }
  return true
}

export function stopAllGlobalChats(): boolean {
  let any = false
  for (const id of new Set([...activeChats.keys(), ...activeChatStops.keys()])) any = stopGlobalChat(id) || any
  return any
}

export type GlobalChatJobCtx = {
  db: any
  schema: any
  sessionId: string
  provider: ReviewProvider
  cwd: string
  model: string
  effort?: string // 空 = 默认
  codexServiceTier?: string | null
  lang: string
  allowDanger?: boolean // 用户开了「允许危险命令」开关 → 放行守卫
  ultracode?: boolean // 后台激活 ultracode（前缀由运行器注入）
  assetsDir: string // issue/PR 配图下载根目录
}

export async function runGlobalChatJob(ctx: GlobalChatJobCtx, message: string): Promise<void> {
  const { db, schema, sessionId } = ctx
  const now = () => new Date().toISOString()
  const emit = makeEmit({ channel: globalChan(sessionId), now }) // global 不落库（不传 eventTable）
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

    // 图片/issue 读取（统一）：消息里引用的 GitHub issue/PR → 抓正文 + 下载配图（含私有附件，用 gh token）→ 喂路径。
    let agentMessage = message
    try {
      const ic = await fetchIssueContext(message, join(ctx.assetsDir, `g-${sessionId}`))
      if (ic) {
        agentMessage = `${message}\n\n【消息里引用的 issue/PR 内容（后端已抓取）】\n${ic.enrichedText}`
        if (ic.imagePaths.length) {
          agentMessage += `\n\n【配图（已下载到本地，先用 Read 逐张打开看）】\n${ic.imagePaths.map((p, i) => `${i + 1}. ${p}`).join('\n')}`
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
    const historyAccess = await prepareAgentHistoryAccess({
      db, schema, scope: 'global', id: sessionId, cwd: ctx.cwd, limit: 80,
    }).catch((e) => {
      emit('stage', `历史入口准备失败，继续本轮：${(e as Error).message}`)
      return undefined
    })
    try {
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
        onSessionId: (sid) => {
          newSessionId = sid
          db.update(schema.globalSessions).set({ ...saveSession(sid), lastUsedAt: now() }).where(eq(schema.globalSessions.id, sessionId)).run()
        },
        onTool: (name, info) => emit('tool', `${name} ${info}`),
        onText: (t) => {
          acc += t
          const n = new Date().getTime()
          if (n - lastWrite > 400) { lastWrite = n; flush('streaming') }
          emit('text', t)
        },
      })
      acc = r.text || acc
      newSessionId = r.sessionId ?? newSessionId
    } catch (e) {
      if (stopRequested.has(sessionId)) stopped = true // 用户停的，不算错误
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
    emit('chat', stopped ? 'stopped' : 'done')
  } catch (e) {
    activeChats.delete(sessionId)
    activeChatStops.delete(sessionId)
    stopRequested.delete(sessionId)
    flush('error')
    const errMsg = (e as Error).message
    db.update(schema.globalSessions).set({ status: 'error', error: errMsg, lastUsedAt: now() }).where(eq(schema.globalSessions.id, sessionId)).run()
    emit('error', errMsg)
  } finally {
    chatLocks.delete(sessionId)
    activeChats.delete(sessionId)
    activeChatStops.delete(sessionId)
    stopRequested.delete(sessionId)
  }
}

import { nanoid } from 'nanoid'
import { eq } from 'drizzle-orm'
import { cockpitBus } from '../events'
import { runGlobalChat } from '../agent/globalChat'
import type { ChildProcess } from 'node:child_process'

// 全局会话 = 一个常驻的「啥都能干」对话。照 fix/pipeline 的骨架（并发锁/turns/SSE/停止/自愈），
// 但没有 worktree/上传那些阶段——它就是自由聊天 + 直接动手。SSE 频道用 `g:<sessionId>` 防与 fix/review 撞。
export const globalChan = (id: string) => `g:${id}`

const chatLocks = new Set<string>()
const activeChats = new Map<string, ChildProcess>()
const stopRequested = new Set<string>()

export function isGlobalChatting(id: string): boolean {
  return chatLocks.has(id)
}

export function stopGlobalChat(id: string): boolean {
  const cp = activeChats.get(id)
  if (!cp || cp.pid == null) return false
  stopRequested.add(id)
  const pid = cp.pid
  // 子进程 detached 起的进程组组长 → 给整组发 SIGINT（等同 Ctrl+C），1.5s 没退强杀。
  try { process.kill(-pid, 'SIGINT') } catch { try { cp.kill('SIGINT') } catch { /* 已退出 */ } }
  setTimeout(() => { try { process.kill(-pid, 'SIGKILL') } catch { /* 已退出 */ } }, 1500)
  return true
}

export type GlobalChatJobCtx = {
  db: any
  schema: any
  sessionId: string
  cwd: string
  model: string
  allowDanger?: boolean // 用户开了「允许危险命令」开关 → 放行 PreToolUse 守卫
}

export async function runGlobalChatJob(ctx: GlobalChatJobCtx, message: string): Promise<void> {
  const { db, schema, sessionId } = ctx
  const now = () => new Date().toISOString()
  const emit = (kind: string, msg?: string) => cockpitBus.emit({ reviewId: globalChan(sessionId), ts: now(), kind, message: msg })
  const row = () => db.select().from(schema.globalSessions).where(eq(schema.globalSessions.id, sessionId)).get()

  // 并发锁：进函数立即占，整个 job 结束才释放。
  if (chatLocks.has(sessionId)) return
  chatLocks.add(sessionId)

  const asstId = nanoid()
  let acc = ''
  let lastWrite = 0
  const flush = (status: string) =>
    db.update(schema.globalTurns).set({ content: acc, status }).where(eq(schema.globalTurns.id, asstId)).run()

  // 整段放进 try/finally：建轮/写库即使抛了也保证释放锁（否则会话永久卡 busy）。
  try {
    // append-only：user 轮 + assistant 占位轮（流式写入）。
    const maxSeq = (db.select().from(schema.globalTurns).where(eq(schema.globalTurns.sessionId, sessionId)).all() as any[])
      .reduce((m: number, t: any) => Math.max(m, t.seq), 0)
    db.insert(schema.globalTurns).values({ id: nanoid(), sessionId, seq: maxSeq + 1, role: 'user', content: message, status: 'done', createdAt: now() }).run()
    db.insert(schema.globalTurns).values({ id: asstId, sessionId, seq: maxSeq + 2, role: 'assistant', content: '', status: 'streaming', createdAt: now() }).run()
    db.update(schema.globalSessions).set({ status: 'streaming', lastUsedAt: now() }).where(eq(schema.globalSessions.id, sessionId)).run()
    emit('chat', 'user')

    let stopped = false
    let newSessionId: string | null = row()?.sessionId ?? null
    try {
      const cur = row()
      const r = await runGlobalChat({
        cwd: ctx.cwd,
        model: ctx.model,
        allowDanger: ctx.allowDanger,
        sessionId: cur?.sessionId ?? null,
        message,
        onSpawn: (cp) => activeChats.set(sessionId, cp),
        onTool: (name, info) => emit('tool', `${name} ${info}`),
        onText: (t) => {
          acc += t
          const n = new Date().getTime()
          if (n - lastWrite > 400) { lastWrite = n; flush('streaming') } // 节流写库
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
      stopRequested.delete(sessionId)
    }
    flush(stopped ? 'stopped' : 'done')
    // 首条消息后用它做标题（截断），方便历史列表展示。
    const cur = row()
    const title = cur?.title || message.trim().slice(0, 60)
    db.update(schema.globalSessions)
      .set({ sessionId: newSessionId, status: 'idle', error: null, title, lastUsedAt: now() })
      .where(eq(schema.globalSessions.id, sessionId))
      .run()
    emit('chat', stopped ? 'stopped' : 'done')
  } catch (e) {
    activeChats.delete(sessionId)
    stopRequested.delete(sessionId)
    flush('error')
    const errMsg = (e as Error).message
    db.update(schema.globalSessions).set({ status: 'error', error: errMsg, lastUsedAt: now() }).where(eq(schema.globalSessions.id, sessionId)).run()
    emit('error', errMsg)
  } finally {
    chatLocks.delete(sessionId)
    activeChats.delete(sessionId)
    stopRequested.delete(sessionId)
  }
}

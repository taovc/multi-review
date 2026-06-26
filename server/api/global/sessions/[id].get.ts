import { asc, eq } from 'drizzle-orm'
import { schema } from '~core/db/client'
import { isGlobalChatting } from '~core/global/pipeline'

// 单段全局会话详情：会话行 + 对话轮（按 seq 升序）。加载历史 / 打开抽屉时用。
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

  // 自愈孤儿流式轮：流式轮存在 ⟺ 正在跑（job 同步先占锁再建轮），唯一例外是进程已死（重启/被杀）。
  // 这种情况收尾成 stopped + session 退回 idle，前端就不会卡在「生成中 / 停止无效」。
  const last = turns[turns.length - 1] as any
  if (last && last.role === 'assistant' && last.status === 'streaming' && !isGlobalChatting(id)) {
    d.update(schema.globalTurns).set({ status: 'stopped' }).where(eq(schema.globalTurns.id, last.id)).run()
    if (session.status === 'streaming') {
      d.update(schema.globalSessions).set({ status: 'idle' }).where(eq(schema.globalSessions.id, id)).run()
      ;(session as any).status = 'idle'
    }
    last.status = 'stopped'
  }
  return { session, turns, chatting: isGlobalChatting(id) }
})

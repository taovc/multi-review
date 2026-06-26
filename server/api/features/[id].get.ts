import { asc, eq } from 'drizzle-orm'
import { schema } from '~core/db/client'
import { isFeatureBusy } from '~core/feature/pipeline'

// feature 任务详情：task + 对话轮 + 解析好的 plan。带孤儿流式轮自愈（重启/被杀后不卡「分析中」）。
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

  const last = turns[turns.length - 1] as any
  if (last && last.role === 'assistant' && last.status === 'streaming' && !isFeatureBusy(id)) {
    d.update(schema.featureTurns).set({ status: 'stopped' }).where(eq(schema.featureTurns.id, last.id)).run()
    last.status = 'stopped'
    if (task.status === 'analyzing') {
      const next = task.planJson ? 'planned' : 'error'
      d.update(schema.featureTasks).set({ status: next, error: task.planJson ? null : '分析中断（服务重启或进程结束）' }).where(eq(schema.featureTasks.id, id)).run()
      ;(task as any).status = next
    } else if (task.status === 'building') {
      // 实现中途崩溃（进程没了）：标 error 让用户能重试（error 仍可批准/开 PR）；worktree 里的部分改动保留。
      d.update(schema.featureTasks).set({ status: 'error', error: '实现中断（服务重启或进程结束）；worktree 改动已保留，可重试或直接开 PR' }).where(eq(schema.featureTasks.id, id)).run()
      ;(task as any).status = 'error'
    }
  }

  const events = d
    .select({ ts: schema.featureEvents.ts, kind: schema.featureEvents.kind, message: schema.featureEvents.message })
    .from(schema.featureEvents)
    .where(eq(schema.featureEvents.taskId, id))
    .orderBy(asc(schema.featureEvents.ts))
    .all()

  let plan: unknown = null
  try { plan = task.planJson ? JSON.parse(task.planJson) : null } catch { /* 坏 JSON → null */ }
  return { task, turns, events, plan, busy: isFeatureBusy(id) }
})

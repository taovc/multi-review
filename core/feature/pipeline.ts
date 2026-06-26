import { nanoid } from 'nanoid'
import { eq } from 'drizzle-orm'
import { cockpitBus } from '../events'
import { runFeaturePlanAgent, renderPlanText } from '../agent/featurePlan'
import type { ReviewProvider } from '../agent/runners'

// Feature 开发 · 阶段1（只读分析 → 方案）。照 review 的非流式模式：跑期间出 stage/tool 事件,
// 完成后把方案落到 task.plan_json + 一条 assistant 轮(可读渲染)。SSE 频道用 f:<taskId>。
export const featureChan = (id: string) => `f:${id}`

const jobLocks = new Set<string>()
export function isFeatureBusy(id: string): boolean {
  return jobLocks.has(id)
}

export type FeaturePlanJobCtx = {
  db: any
  schema: any
  taskId: string
  cwd: string
  provider: ReviewProvider
  model: string
  effort: string
  lang: string
  methodology?: string | null
}

// message：本轮用户输入。首轮(创建时)= 需求原文；之后 = 对上一版方案的细化/反馈 → 重新出方案。
export async function runFeaturePlanJob(ctx: FeaturePlanJobCtx, message: string): Promise<void> {
  const { db, schema, taskId } = ctx
  const now = () => new Date().toISOString()
  const emit = (kind: string, msg?: string) => cockpitBus.emit({ reviewId: featureChan(taskId), ts: now(), kind, message: msg })
  const task = () => db.select().from(schema.featureTasks).where(eq(schema.featureTasks.id, taskId)).get()

  if (jobLocks.has(taskId)) return
  jobLocks.add(taskId)

  // append-only：user 轮 + assistant 占位轮（分析完成后写入方案文本）。
  const maxSeq = (db.select().from(schema.featureTurns).where(eq(schema.featureTurns.taskId, taskId)).all() as any[])
    .reduce((m: number, t: any) => Math.max(m, t.seq), 0)
  db.insert(schema.featureTurns).values({ id: nanoid(), taskId, seq: maxSeq + 1, role: 'user', content: message, status: 'done', createdAt: now() }).run()
  const asstId = nanoid()
  db.insert(schema.featureTurns).values({ id: asstId, taskId, seq: maxSeq + 2, role: 'assistant', content: '', status: 'streaming', createdAt: now() }).run()
  db.update(schema.featureTasks).set({ status: 'analyzing', error: null, updatedAt: now() }).where(eq(schema.featureTasks.id, taskId)).run()
  emit('chat', 'user')

  try {
    const t = task()
    emit('stage', 'AI 调研分析中…')
    const { plan, raw } = await runFeaturePlanAgent({
      cwd: ctx.cwd,
      provider: ctx.provider,
      model: ctx.model,
      effort: ctx.effort,
      lang: ctx.lang,
      methodology: ctx.methodology,
      description: t?.description || '',
      instruction: message || undefined,
      onTool: (n, i) => emit('tool', `${n} ${i}`),
    })
    const text = renderPlanText(plan) || raw.slice(0, 2000)
    db.update(schema.featureTurns).set({ content: text, status: 'done' }).where(eq(schema.featureTurns.id, asstId)).run()
    const title = t?.title || (t?.description || '').trim().slice(0, 60)
    db.update(schema.featureTasks)
      .set({ status: 'planned', planJson: JSON.stringify(plan), error: null, title, updatedAt: now() })
      .where(eq(schema.featureTasks.id, taskId))
      .run()
    emit('chat', 'done')
  } catch (e) {
    db.update(schema.featureTurns).set({ status: 'error' }).where(eq(schema.featureTurns.id, asstId)).run()
    const errMsg = (e as Error).message
    db.update(schema.featureTasks).set({ status: 'error', error: errMsg, updatedAt: now() }).where(eq(schema.featureTasks.id, taskId)).run()
    emit('error', errMsg)
  } finally {
    jobLocks.delete(taskId)
  }
}

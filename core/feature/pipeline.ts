import { nanoid } from 'nanoid'
import { eq } from 'drizzle-orm'
import { existsSync } from 'node:fs'
import { cockpitBus } from '../events'
import { runFeaturePlanAgent, renderPlanText, type Plan } from '../agent/featurePlan'
import { prepareFeatureWorktree } from '../git/worktree'
import { selectChatRunner } from '../fix/pipeline'
import type { ChildProcess } from 'node:child_process'
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

// ── 阶段2：实现（批准后）。在「从默认分支拉的新功能分支 worktree」里改代码，不自动 commit。
// 复用 fix 的聊天 runner（acceptEdits + 全工具 + 「别 commit」），把已批准方案 + 决策答复作为高优先级注入。
const activeFeatureChats = new Map<string, ChildProcess>()
const featureStopRequested = new Set<string>()
const featureStops = new Map<string, () => void>()

export function stopFeatureImpl(taskId: string): boolean {
  const stop = featureStops.get(taskId)
  if (stop) { featureStopRequested.add(taskId); stop(); return true }
  const cp = activeFeatureChats.get(taskId)
  if (!cp || cp.pid == null) return false
  featureStopRequested.add(taskId)
  const pid = cp.pid
  try { process.kill(-pid, 'SIGINT') } catch { try { cp.kill('SIGINT') } catch { /* 已退出 */ } }
  setTimeout(() => { try { process.kill(-pid, 'SIGKILL') } catch { /* 已退出 */ } }, 1500)
  return true
}

function slugify(s: string): string {
  return (s || 'feature').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'feature'
}

// 把已批准方案 + 决策答复拼成实现阶段的首条指令。
export function buildImplementMessage(plan: Plan, decisions: Record<string, string>, lang: string): string {
  const dlines = plan.decisionPoints.map((d) => {
    const ans = decisions[d.id] || d.defaultChoice || d.recommendation || '(用推荐/默认)'
    return `  - ${d.question} → 选定：${ans}`
  })
  return `以下方案已经用户批准，请据此实现（这是阶段2：可写）。

【已批准方案】
${plan.approach}

【分步计划】
${plan.plannedSteps.map((s, i) => `${i + 1}. ${s}`).join('\n')}
${dlines.length ? `\n【决策答复（最高优先级，严格遵守）】\n${dlines.join('\n')}` : ''}
${plan.outOfScope.length ? `\n【不在本次范围，别做】\n${plan.outOfScope.map((s) => `- ${s}`).join('\n')}` : ''}

在当前 worktree 里直接改文件实现。偏离已批准方案要回到方案，不要自作主张改方向。**不要 commit / push**——改动留在 worktree，用户点「开 PR」才提交。完成后简述你改了什么（用 ${lang === 'en' ? 'English' : lang === 'fr' ? 'French' : '中文'}）。`
}

export type FeatureImplJobCtx = {
  db: any
  schema: any
  taskId: string
  localPath: string
  reposDir: string
  provider: ReviewProvider
  model: string
  effort?: string
  defaultBranch: string
  lang: string
}

export async function runFeatureImplJob(ctx: FeatureImplJobCtx, message: string): Promise<void> {
  const { db, schema, taskId } = ctx
  const now = () => new Date().toISOString()
  const emit = (kind: string, msg?: string) => cockpitBus.emit({ reviewId: featureChan(taskId), ts: now(), kind, message: msg })
  const task = () => db.select().from(schema.featureTasks).where(eq(schema.featureTasks.id, taskId)).get()
  const saveSession = (sid: string | null) => (ctx.provider === 'codex' ? { codexSessionId: sid } : { sessionId: sid })

  if (jobLocks.has(taskId)) return
  jobLocks.add(taskId)

  const maxSeq = (db.select().from(schema.featureTurns).where(eq(schema.featureTurns.taskId, taskId)).all() as any[])
    .reduce((m: number, t: any) => Math.max(m, t.seq), 0)
  db.insert(schema.featureTurns).values({ id: nanoid(), taskId, seq: maxSeq + 1, role: 'user', content: message, status: 'done', createdAt: now() }).run()
  const asstId = nanoid()
  db.insert(schema.featureTurns).values({ id: asstId, taskId, seq: maxSeq + 2, role: 'assistant', content: '', status: 'streaming', createdAt: now() }).run()
  db.update(schema.featureTasks).set({ status: 'building', error: null, updatedAt: now() }).where(eq(schema.featureTasks.id, taskId)).run()
  emit('chat', 'user')

  let acc = ''
  let lastWrite = 0
  const flush = (status: string) => db.update(schema.featureTurns).set({ content: acc, status }).where(eq(schema.featureTurns.id, asstId)).run()

  try {
    let stopped = false
    const t = task()
    // 确保新分支 worktree（首次实现时建）
    let wtPath = t?.worktreePath as string | null
    if (!wtPath || !existsSync(wtPath)) {
      emit('stage', '准备 worktree（新功能分支）')
      const branch = t?.branch || `feat/${slugify(t?.title || t?.description)}-${taskId.slice(0, 6)}`
      const wt = await prepareFeatureWorktree({
        localPath: ctx.localPath, reposDir: ctx.reposDir, taskId,
        newBranch: branch, defaultBranch: t?.baseBranch || ctx.defaultBranch,
        onStep: (m) => emit('stage', m),
      })
      wtPath = wt.path
      db.update(schema.featureTasks).set({ worktreePath: wt.path, baseHeadSha: wt.headSha, branch, updatedAt: now() }).where(eq(schema.featureTasks.id, taskId)).run()
    }

    let newSessionId: string | null = (ctx.provider === 'codex' ? t?.codexSessionId : t?.sessionId) ?? null
    try {
      const cur = task()
      const r = await selectChatRunner(ctx.provider).runChat({
        cwd: wtPath!,
        model: ctx.model,
        effort: ctx.effort,
        lang: ctx.lang,
        sessionId: (ctx.provider === 'codex' ? cur?.codexSessionId : cur?.sessionId) ?? null,
        message,
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
    // 实现完成（或停止）：改动留在 worktree 未提交，状态 → built（待开 PR）。
    db.update(schema.featureTasks).set({ status: 'built', error: null, ...saveSession(newSessionId), updatedAt: now() }).where(eq(schema.featureTasks.id, taskId)).run()
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

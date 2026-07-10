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

// Feature 开发 · 单段式（原生 agent）：一个任务 = 一个隔离 worktree（新功能分支）里的自由开发对话。
// 不再分「只读方案 → 批准 → 实现」两段；agent 直接动手，遇到真决策点用 ```ask-user 块问用户（→ awaiting），
// 用户点「开 PR」就让 agent 自己 commit/push/开 PR。每轮结束按分支回查 gh 联动 PR 状态。SSE 频道 f:<taskId>。
export const featureChan = (id: string) => `f:${id}`

// agent 在等用户拍板的标记：产出里含 ```ask-user 围栏块 → 本轮以「等你确认」收尾。
const ASK_RE = /```ask-user\b/i
export function hasAskBlock(text: string): boolean {
  return ASK_RE.test(text || '')
}

const jobLocks = new Set<string>()
export function isFeatureBusy(id: string): boolean {
  return jobLocks.has(id)
}

// 停止状态：featureStops = runner 暴露的中断回调；activeFeatureChats = 子进程句柄（kill 用）；
// featureStopRequested = 用户主动停的标记 → 把那轮标 stopped 而非 error。
const activeFeatureChats = new Map<string, ChildProcess>()
const featureStopRequested = new Set<string>()
const featureStops = new Map<string, () => void>()

function slugify(s: string): string {
  return (s || 'feature').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'feature'
}

// 确保 feature 的隔离 worktree（从 origin/<default> 拉的新功能分支）。开发全程在它里头跑——
// **绝不碰用户真实的本地 clone**。首次创建，之后复用；丢了就按原分支重建。
// 分支名 slugify 成纯 [a-z0-9-]，避免 nanoid 的 `_` 触发 SAFE_REF 拦截。
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
  try { process.kill(-pid, 'SIGINT') } catch { try { cp.kill('SIGINT') } catch { /* 已退出 */ } }
  setTimeout(() => { try { process.kill(-pid, 'SIGKILL') } catch { /* 已退出 */ } }, 1500)
  return true
}

// 进程退出(app 关闭)时把所有在跑的 feature 开发停掉（子进程组），别留孤儿。
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
  repo: string // owner/name，回查 gh PR 用
  provider: ReviewProvider
  model: string
  translateModel: string // 便宜/快模型（生成任务标题用；跟随 provider，同 assembleReview 的 translate）
  effort?: string
  codexServiceTier?: string | null
  lang: string
  allowDanger?: boolean // 用户开了「允许危险命令」/ 点了「开 PR」→ 放行危险命令守卫（含 git push / gh pr create）
  ultracode?: boolean // 后台激活 ultracode；存库仍是干净消息，具体执行方式交给 provider runner
  assetsDir: string // issue/PR 配图下载根目录（首轮抓 issue 用）
}

// message = 本轮用户输入（首轮=需求原文；之后=继续对话 / 决策答复 / 「帮我开 PR」）。
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
    // append-only：user 轮（干净 message）+ assistant 占位轮（流式写入）。
    asstId = appendTurns({ db, turnTable: schema.featureTurns, fkField: 'taskId', fkValue: taskId, now, message }).assistantId
    db.update(schema.featureTasks).set({ status: 'working', error: null, updatedAt: now() }).where(eq(schema.featureTasks.id, taskId)).run()
    emit('chat', 'user')

    const t0 = task()
    const isFirstTurn = !(ctx.provider === 'codex' ? t0?.codexSessionId : t0?.sessionId)

    // 送给 agent 的消息（可能被增强/前缀）；存库/展示的仍是原始干净 message。
    let agentMessage = message
    let issueEnriched = '' // 首轮抓到的 issue 正文，也喂给「读懂需求」标题生成
    // 首轮：抓 issue/PR 正文 + 下载配图（agent 上不了网、下不了图；只做一次）。
    if (isFirstTurn) {
      try {
        const ic = await fetchIssueContext(`${t0?.description || ''}\n${message || ''}`, join(ctx.assetsDir, taskId))
        if (ic) {
          issueEnriched = ic.enrichedText
          agentMessage = `${message}\n\n【需求相关的 issue/PR 内容（后端已抓取）】\n${ic.enrichedText}`
          if (ic.imagePaths.length) {
            agentMessage += `\n\n【配图（已下载到本地，先用 Read 逐张打开看再动手）】\n${ic.imagePaths.map((p, i) => `${i + 1}. ${p}`).join('\n')}`
          }
          emit('stage', `已抓取 issue/PR 内容（${ic.summary}）`)
        }
      } catch (e) {
        emit('stage', `issue/PR 抓取失败，用原始需求继续：${(e as Error).message}`)
      }
    }
    // 首轮且还没标题：读懂需求生成一句短标题（便宜快模型，后台异步不阻塞 develop；失败则列表回退显示描述）。
    if (isFirstTurn && !t0?.title) {
      void genFeatureTitle({ provider: ctx.provider, model: ctx.translateModel, requirement: `${t0?.description || message}\n${issueEnriched}`, lang: ctx.lang, cwd: ctx.localPath })
        .then((title) => { if (title) db.update(schema.featureTasks).set({ title, updatedAt: now() }).where(eq(schema.featureTasks.id, taskId)).run() })
        .catch(() => { /* 生成失败无所谓，列表回退显示描述 */ })
    }
    // ultracode 前缀由共享运行器（chat.ts / runCodexChat）按 flag 注入，这里不再拼。

    // 确保新分支 worktree（首轮建；之后复用）。绝不碰真实本地 clone。
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
        ultracode: ctx.ultracode, // 前缀由运行器注入
        baseBranch: cur?.baseBranch || ctx.defaultBranch, // 开 PR 时 gh pr create --base 用它

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

    // 收尾：PR 回查与「等你拍板」解耦——agent 可能同一轮既开了 PR 又提了问，两者都要处理。
    // ① 只在可能有 PR 时才回查 gh（这轮放行了危险命令 / 之前已开过 PR）——省掉必为 null 的往返；
    //    查到就联动 prUrl/prNumber；opened 借「PR 仍在 GitHub 上」天然粘滞，不因后续提问回合丢失。
    // ② badge：agent 在等你拍板 → awaiting（此时 prUrl 仍照记，链接不丢）；否则有 PR → opened；否则 working。
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

import { nanoid } from 'nanoid'
import { eq } from 'drizzle-orm'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fetchIssueContext } from '../github/issueAssets'
import { prepareWorktree, removeWorktree } from '../git/worktree'
import { claudeChatRunner } from '../agent/claudeRunners'
import { codexChatRunner } from '../agent/codexChat'
import { hasUploadable } from './changes'
import { computeFixNextStatus } from './status'
import { appendTurns } from '../db/turns'
import { makeEmit } from '../streaming/emit'
import { sessionFields } from '../agent/session'
import { prepareAgentHistoryAccess } from '../agent/historyAccess'
import { fetchReviewsCount } from '../github/gh'
import type { ChildProcess } from 'node:child_process'
import type { ChatRunner, ReviewProvider } from '../agent/runners'

const pexec = promisify(execFile)
const git = (wt: string, args: string[]) => pexec('git', ['-C', wt, ...args], { maxBuffer: 64 * 1024 * 1024 })

// 修复 PR = 一个常驻对话：在 PR 分支的 git worktree 里和 agent 聊，让它直接改文件（落盘，不 commit）。
// 用户在 UI 点「提交并上传」才 commit + push（见 push.post.ts）。没有验证/批量修复/合并默认分支/回复作者这些阶段。

export function selectChatRunner(provider?: ReviewProvider): ChatRunner {
  return provider === 'codex' ? codexChatRunner : claudeChatRunner
}

// 并发锁：job 一进来就占（spawn 前就生效），直到整个 job 结束才释放。
// 用它防并发，而不是 activeChats —— 后者要等子进程 spawn 才有、子进程一结束就空，两头都漏窗口。
const chatLocks = new Set<string>()
// 真子进程句柄（spawn 后才有），停止按钮 kill 用。
const activeChats = new Map<string, ChildProcess>()
// SDK runner 没有子进程句柄，用 runner 暴露的 stop 回调中断。
const activeChatStops = new Map<string, () => void>()
const stopRequested = new Set<string>() // 用户主动停止的 → job 把那轮标记 stopped（而非 error）
export function isChatting(fixId: string): boolean {
  return chatLocks.has(fixId)
}
export function stopFixChat(fixId: string): boolean {
  const stop = activeChatStops.get(fixId)
  if (stop) {
    stopRequested.add(fixId)
    stop()
    return true
  }
  const cp = activeChats.get(fixId)
  if (!cp || cp.pid == null) return false // 还在准备 worktree（没 spawn）或没在跑 → 没句柄可 kill
  stopRequested.add(fixId)
  const pid = cp.pid
  // 子进程是 detached 起的进程组组长 → 给「整个组」发 SIGINT（含它 spawn 的子进程），等同 Ctrl+C。
  // agent 已落盘的改动会保留，等用户上传。
  try { process.kill(-pid, 'SIGINT') } catch { try { cp.kill('SIGINT') } catch { /* 已退出 */ } }
  // 兜底：1.5s 还没退就强杀整组
  setTimeout(() => { try { process.kill(-pid, 'SIGKILL') } catch { /* 已退出 */ } }, 1500)
  return true
}

// 进程退出(app 关闭)时把所有在跑的修复会话停掉(CLI 子进程组 + SDK runner),别留孤儿。
export function stopAllFixChats(): boolean {
  let any = false
  for (const id of new Set([...activeChats.keys(), ...activeChatStops.keys()])) any = stopFixChat(id) || any
  return any
}

// db/schema 由调用方注入（core 不直接依赖运行时 db）。
export type FixJobCtx = {
  db: any
  schema: any
  fixId: string
  repo: string
  prNumber: number
  branch: string
  defaultBranch: string
  localPath: string
  reposDir: string
  worktreeLocation?: string | null
  provider?: ReviewProvider
  model: string // 当前 provider 的实模型（不混用）
  effort?: string
  codexServiceTier?: string | null
  lang: string
  allowDanger?: boolean // 放行危险命令守卫（含 git push / gh pr create），默认拦
  ultracode?: boolean // 后台激活 ultracode（前缀由运行器注入）
  assetsDir: string // issue/PR 配图下载根目录（读图统一）
}

// ── 共用的小工具 ──────────────────────────────────────────────
function helpers(ctx: FixJobCtx) {
  const { db, schema, fixId } = ctx
  const now = () => new Date().toISOString()
  // 事件走实时总线 + 落 fix_events（供打开任务时回填历史日志，同审核 drawer）。频道=裸 fixId。
  const emit = makeEmit({ channel: fixId, now, db, eventTable: schema.fixEvents, fkField: 'fixId', fkValue: fixId })
  const row = () => db.select().from(schema.fixes).where(eq(schema.fixes.id, fixId)).get()
  return { now, emit, row }
}

// worktree 复用：第一次对话时建好，之后一直留到 push/discard；中途丢了（重启清理等）就按原分支重建。
async function ensureWorktree(ctx: FixJobCtx, h: ReturnType<typeof helpers>) {
  const r = h.row()
  if (r?.worktreePath && existsSync(r.worktreePath)) {
    return { path: r.worktreePath as string, headSha: r.baseHeadSha as string }
  }
  const wt = await prepareWorktree({
    localPath: ctx.localPath,
    reposDir: ctx.reposDir,
    location: ctx.worktreeLocation,
    reviewId: ctx.fixId,
    branch: ctx.branch,
    defaultBranch: ctx.defaultBranch,
    mergeDefault: false, // 修复要 push，不 merge 默认分支 → 推上去的 commit 干净
    onStep: (m) => h.emit('stage', m),
  })
  ctx.db.update(ctx.schema.fixes).set({ worktreePath: wt.path, baseHeadSha: wt.headSha, updatedAt: h.now() }).where(eq(ctx.schema.fixes.id, ctx.fixId)).run()
  return { path: wt.path, headSha: wt.headSha }
}

async function currentHead(wt: string): Promise<string | null> {
  const { stdout } = await git(wt, ['rev-parse', 'HEAD']).catch(() => ({ stdout: '' }))
  return stdout.trim() || null
}

async function conflictHint(wt: string): Promise<string | undefined> {
  const { stdout } = await git(wt, ['diff', '--name-only', '--diff-filter=U']).catch(() => ({ stdout: '' }))
  const files = stdout.trim().split('\n').map((s) => s.trim()).filter(Boolean)
  if (!files.length) return undefined
  return `There are UNRESOLVED merge conflicts in these files (they contain <<<<<<< / ======= / >>>>>>> markers): ${files.join(', ')}. Resolve every conflict by editing the files and removing all conflict markers.`
}

// ── 对话：在 worktree 里续聊继续改 ──────────────────────────────
// 不走 reviewQueue（交互式，即时跑）；同一 fix 同时只允许一个 chat（endpoint 用 isChatting 拦）。
export async function runFixChatJob(ctx: FixJobCtx, message: string): Promise<void> {
  const { db, schema, fixId } = ctx
  const h = helpers(ctx)

  // 并发锁：进函数立即占（endpoint 已用 isChatting 拦一道，这里再兜底防 race）。整个 job 结束才释放。
  if (chatLocks.has(fixId)) return
  chatLocks.add(fixId)

  // append-only 轮次：user 轮 + assistant 占位轮（流式写入）
  const { assistantId: asstId } = appendTurns({ db, turnTable: schema.fixTurns, fkField: 'fixId', fkValue: fixId, now: h.now, message })
  h.emit('chat', 'user')

  // 我介入对话 = 已回应这一轮审核 → 在对话起点把「审核已更新」基线（reviewsAtPush）抬到当前 review 数，清掉红点。
  // 放在起点而非结束：对话期间/之后才提交的新审核（count 继续增长）仍会重新点亮。
  // 仅在已 push 过（pushedAt 有值，reviewerUpdated 才可能为真）时才取数，省掉无谓的网络调用。
  try {
    const fr = h.row()
    if (fr?.pushedAt) {
      const reviewsNow = await fetchReviewsCount(ctx.repo, ctx.prNumber).catch(() => null)
      if (reviewsNow != null) db.update(schema.fixes).set({ reviewsAtPush: reviewsNow, updatedAt: h.now() }).where(eq(schema.fixes.id, fixId)).run()
    }
  } catch { /* 取数失败不影响对话 */ }

  let acc = ''
  let lastWrite = 0
  const flushTurn = (status: string) =>
    db.update(schema.fixTurns).set({ content: acc, status }).where(eq(schema.fixTurns.id, asstId)).run()

  try {
    try {
      const wt = await ensureWorktree(ctx, h)
      const fix = h.row()
      let stopped = false
      // 读图（统一）：reviewer 消息里引用的 GitHub issue/PR → 抓正文 + 下载配图（含私有附件，用 gh token）→ 喂路径。
      let agentMessage = message
      try {
        const ic = await fetchIssueContext(message, join(ctx.assetsDir, `fix-${fixId}`))
        if (ic) {
          agentMessage = `${message}\n\n【消息里引用的 issue/PR 内容（后端已抓取）】\n${ic.enrichedText}`
          if (ic.imagePaths.length) {
            agentMessage += `\n\n【配图（已下载到本地，先用 Read 逐张打开看）】\n${ic.imagePaths.map((p, i) => `${i + 1}. ${p}`).join('\n')}`
          }
          h.emit('stage', `已抓取 issue/PR 内容（${ic.summary}）`)
        }
      } catch (e) {
        h.emit('stage', `issue/PR 抓取失败，用原始消息继续：${(e as Error).message}`)
      }
      // session 按 provider 各存各的列：claude→session_id，codex→codex_session_id。
      // 切换 provider 时各自 resume 自己的线程，不会拿对方的 id 去 resume（避免报错 / 串上下文 / 混用）。
      const saveSession = (sid: string | null) => sessionFields(ctx.provider, sid)
      const resumeId: string | null = (ctx.provider === 'codex' ? fix?.codexSessionId : fix?.sessionId) ?? null
      let newSessionId: string | null = resumeId
      const headBeforeCodex = ctx.provider === 'codex' ? await currentHead(wt.path) : null
      const historyAccess = await prepareAgentHistoryAccess({
        db, schema, scope: 'fix', id: fixId, cwd: wt.path, limit: 80,
      }).catch((e) => {
        h.emit('stage', `历史入口准备失败，继续本轮：${(e as Error).message}`)
        return undefined
      })
      try {
        const chatRunner = selectChatRunner(ctx.provider)
        const r = await chatRunner.runChat({
          cwd: wt.path,
          model: ctx.model,
          effort: ctx.effort,
          codexServiceTier: ctx.codexServiceTier,
          lang: ctx.lang,
          sessionId: resumeId,
          message: agentMessage,
          historyAccess,
          allowDanger: ctx.allowDanger,
          ultracode: ctx.ultracode,
          conflictHint: await conflictHint(wt.path),
          onSpawn: (cp) => activeChats.set(fixId, cp),
          onStop: (stop) => activeChatStops.set(fixId, stop),
          onSessionId: (sessionId) => {
            newSessionId = sessionId
            db.update(schema.fixes).set({ ...saveSession(sessionId), updatedAt: h.now() }).where(eq(schema.fixes.id, fixId)).run()
          },
          onTool: (name, info) => h.emit('tool', `${name} ${info}`), // 工具调用 → tool 事件 → 实时进日志 + 内联步骤
          onText: (t) => {
            acc += t
            const n = new Date().getTime()
            if (n - lastWrite > 400) { lastWrite = n; flushTurn('streaming') } // 节流写库
            h.emit('text', t) // 完整推给前端实时流式拼接（不落库，见 emit 的 text 排除）
          },
        })
        acc = r.text || acc
        newSessionId = r.sessionId ?? newSessionId
        if (ctx.provider === 'codex' && headBeforeCodex) {
          const headAfterCodex = await currentHead(wt.path)
          if (headAfterCodex && headAfterCodex !== headBeforeCodex) {
            throw new Error('Codex chat changed git HEAD. Codex must leave commits to the existing upload path; inspect the worktree before retrying.')
          }
        }
      } catch (e) {
        if (stopRequested.has(fixId)) stopped = true // 用户停的，不算错误
        else throw e
      } finally {
        activeChats.delete(fixId)
        activeChatStops.delete(fixId)
        stopRequested.delete(fixId)
      }

      flushTurn(stopped ? 'stopped' : 'done')

      // 不自动 commit：agent 的改动留在 worktree 未提交，等用户点「提交并上传」。
      // 有未提交改动 或 已提交未推 → 标 ready「待上传」(列表/抽屉一眼可见)；否则停留 open / 保持 pushed。
      // 只更新 sessionId 供下次续聊；改动统计由 [id].get 用 fixChangesStat 从（含未提交的）worktree 实时算。
      const up = await hasUploadable(wt.path, ctx.branch).catch(() => ({ dirty: false, ahead: false }))
      const cur = h.row()
      const nextStatus = computeFixNextStatus({ dirty: up.dirty, ahead: up.ahead, currentStatus: cur?.status })
      db.update(schema.fixes).set({ status: nextStatus, error: null, ...saveSession(newSessionId), updatedAt: h.now() }).where(eq(schema.fixes.id, fixId)).run()
      h.emit('chat', stopped ? 'stopped' : 'done')
    } catch (e) {
      activeChats.delete(fixId)
      activeChatStops.delete(fixId)
      stopRequested.delete(fixId)
      flushTurn('error')
      const errMsg = (e as Error).message
      // 出错时两个 provider 一致：fix 标 error + 错误信息落库可见（轮也是 error）。
      // 已落盘的改动仍留在 worktree，error 状态也允许上传（UPLOADABLE 含 error）。
      db.update(schema.fixes).set({ status: 'error', error: errMsg, updatedAt: h.now() }).where(eq(schema.fixes.id, fixId)).run()
      h.emit('error', errMsg)
    }
  } finally {
    // 并发锁直到这里（整个 job 含 db 收尾都结束）才释放，杜绝第二个 chat 在收尾期间挤进来
    chatLocks.delete(fixId)
    activeChats.delete(fixId)
    activeChatStops.delete(fixId)
    stopRequested.delete(fixId)
  }
}

// discard / 删除任务时清 worktree
export async function cleanupFixWorktree(
  localPath: string | null,
  reposDir: string,
  fixId: string,
  opts: { worktreeLocation?: string | null; worktreePath?: string | null } = {},
) {
  await removeWorktree(localPath, reposDir, fixId, { location: opts.worktreeLocation, worktreePath: opts.worktreePath })
}

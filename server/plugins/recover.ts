import { inArray, eq } from 'drizzle-orm'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { getDb, schema } from '~core/db/client'
import { removeWorktree } from '~core/git/worktree'

const pexec = promisify(execFile)

// 启动恢复：上一个进程里「在跑」的任务会随进程死掉。服务一启动就把卡住的恢复到一致状态。
// - 审核任务（agent 在跑）：重置为 error + 清 worktree。
// - 修复任务：纯对话版没有 agent 阶段状态（对话进行靠内存锁，重启即释放）；唯一要对账的是 pushing
//   （提交并上传中途崩溃，push 可能已到 GitHub）。中断的对话轮只标 stopped，改动留 worktree 等用户上传（不自动 commit）。
const REVIEW_IN_FLIGHT = ['queued', 'cloning', 'reviewing', 'recheck_requested', 'rechecking']

export default defineNitroPlugin(async () => {
  const cfg = useRuntimeConfig()
  const d = getDb(cfg.dbPath as string)
  const now = () => new Date().toISOString()
  const git = (wt: string, args: string[]) => pexec('git', ['-C', wt, ...args], { maxBuffer: 64 * 1024 * 1024, timeout: 15000 })

  // 1) 审核任务：重置 + 清 worktree（审核 worktree 用完即弃）
  try {
    const stuck = d.select().from(schema.reviews).where(inArray(schema.reviews.status, REVIEW_IN_FLIGHT as any)).all()
    if (stuck.length) {
      const projects = new Map(d.select().from(schema.projects).all().map((p: any) => [p.id, p]))
      for (const r of stuck) {
        d.update(schema.reviews)
          .set({ status: 'error', error: '服务重启导致审核中断，请重新审核', updatedAt: now() })
          .where(eq(schema.reviews.id, r.id))
          .run()
        const proj: any = projects.get(r.projectId)
        await removeWorktree(proj?.localPath ?? null, cfg.reposDir as string, r.id)
      }
      console.log(`[recover] 重置了 ${stuck.length} 个中断的审核任务并清理 worktree`)
    }
  } catch (e) {
    console.error('[recover] 审核任务启动恢复失败', e)
  }

  // 1.5) 发评论中断（posting）：agent 阶段早已结束、findings 完好，只是发布窗口随进程崩了。
  // 重置为 ready_to_post（不自动重发——发布可能已到 GitHub，自动重发会重复评论；由用户在 UI 决定是否再发）。
  try {
    const stuck = d.select().from(schema.reviews).where(eq(schema.reviews.status, 'posting' as any)).all()
    for (const r of stuck as any[]) {
      d.update(schema.reviews).set({ status: 'ready_to_post', updatedAt: now() }).where(eq(schema.reviews.id, r.id)).run()
    }
    if (stuck.length) console.log(`[recover] 重置了 ${stuck.length} 个中断的发布（posting → ready_to_post，请在 GitHub 确认后再决定是否重发）`)
  } catch (e) {
    console.error('[recover] posting 启动恢复失败', e)
  }

  // 2) pushing 中断：push 可能已经到 GitHub 了（只是没写回 DB）。对账 origin/<branch> 与 fixHeadSha：
  // 一致 = 已成功 → pushed；否则 → error（让用户重新上传，push 幂等无副作用）。
  try {
    const stuck = d.select().from(schema.fixes).where(eq(schema.fixes.status, 'pushing' as any)).all()
    for (const f of stuck as any[]) {
      let pushed = false
      // 比 worktree 的「真实 HEAD」而不是 DB 里的 fixHeadSha：commit 已完成但写回 DB 前崩溃时，DB 值是旧的，
      // 拿旧值对账会把「本地有新提交、远端还是旧的」误判成已推、从而丢掉这条本地提交。
      let localHead: string = f.fixHeadSha
      if (f.worktreePath && existsSync(f.worktreePath) && f.branch) {
        try { localHead = (await git(f.worktreePath, ['rev-parse', 'HEAD'])).stdout.trim() || f.fixHeadSha } catch { /* 用 DB 值兜底 */ }
        try {
          const { stdout } = await git(f.worktreePath, ['ls-remote', 'origin', f.branch])
          const remoteSha = stdout.trim().split(/\s+/)[0] || ''
          pushed = !!remoteSha && !!localHead && remoteSha === localHead
        } catch { /* 网络/远端不可达 → 当作未成功 */ }
      }
      if (pushed) {
        d.update(schema.fixes)
          .set({ status: 'pushed', error: null, fixHeadSha: localHead, lastPushSha: localHead, lastActionKind: 'pushed', pushedAt: f.pushedAt || now(), lastUploadAt: now(), updatedAt: now() })
          .where(eq(schema.fixes.id, f.id))
          .run()
      } else {
        d.update(schema.fixes)
          .set({ status: 'error', error: '上传中断，请重新上传', updatedAt: now() })
          .where(eq(schema.fixes.id, f.id))
          .run()
      }
    }
    if (stuck.length) console.log(`[recover] 对账了 ${stuck.length} 个中断的上传`)
  } catch (e) {
    console.error('[recover] 上传启动恢复失败', e)
  }

  // 3) 对话轮中断：流式中的 assistant 轮 → stopped。改动留在 worktree（未提交），下次打开靠 dirty 检测出现上传按钮。
  try {
    const streaming = d.select().from(schema.fixTurns).where(eq(schema.fixTurns.status, 'streaming' as any)).all()
    for (const tn of streaming as any[]) {
      d.update(schema.fixTurns).set({ status: 'stopped' }).where(eq(schema.fixTurns.id, tn.id)).run()
    }
    if (streaming.length) console.log(`[recover] 重置了 ${streaming.length} 个中断的对话轮`)
  } catch (e) {
    console.error('[recover] 对话轮启动恢复失败', e)
  }
})

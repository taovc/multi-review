import { inArray, eq } from 'drizzle-orm'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { getDb, schema } from '~core/db/client'
import { migrateWorktreeToRepo, removeWorktree } from '~core/git/worktree'

const pexec = promisify(execFile)

// Startup recovery: tasks that were "running" in the previous process die with it. As soon as the server starts,
// bring anything stuck back to a consistent state.
// - Review tasks (agent running): reset to error + clean the worktree.
// - Fix tasks: the chat-only version has no agent stage state (an in-flight chat is held by an in-memory lock, released
//   on restart); the only thing to reconcile is pushing (a crash midway through commit-and-push, where the push may
//   already have reached GitHub). Interrupted chat turns are just marked stopped, and the changes stay in the worktree
//   waiting for the user to upload them (no automatic commit).
const REVIEW_IN_FLIGHT = ['queued', 'cloning', 'reviewing', 'recheck_requested', 'rechecking']

export default defineNitroPlugin(async () => {
  const cfg = useRuntimeConfig()
  const d = getDb(cfg.dbPath as string)
  const now = () => new Date().toISOString()
  const git = (wt: string, args: string[]) => pexec('git', ['-C', wt, ...args], { maxBuffer: 64 * 1024 * 1024, timeout: 15000 })

  // 0) By default migrate into .pr-cockpit-worktrees/ inside the project repo.
  // Only persistent worktrees that still exist are moved (fix / feature); review worktrees are temporary and startup recovery cleans them up.
  try {
    const projects = new Map(d.select().from(schema.projects).all().map((p: any) => [p.id, p]))
    let moved = 0
    let cleared = 0
    const writePath = (kind: 'fix' | 'feature', id: string, worktreePath: string | null) => {
      if (kind === 'fix') {
        d.update(schema.fixes).set({ worktreePath, updatedAt: now() }).where(eq(schema.fixes.id, id)).run()
      } else {
        d.update(schema.featureTasks).set({ worktreePath, updatedAt: now() }).where(eq(schema.featureTasks.id, id)).run()
      }
    }
    const moveOne = async (kind: 'fix' | 'feature', row: any) => {
      // The directory is long gone (cleaned on restart / deleted by hand) but the path to the old central directory is
      // still recorded: migration can't move it, and keeping it makes "upload" fail outright with worktree gone.
      // Clearing it → the next chat takes the existsSync rebuild branch and recreates it at the new location on the same branch.
      if (!existsSync(row.worktreePath)) {
        writePath(kind, row.id, null)
        cleared++
        return
      }
      const proj: any = projects.get(row.projectId)
      const nextPath = await migrateWorktreeToRepo({
        localPath: proj?.localPath ?? null,
        reposDir: cfg.reposDir as string,
        taskId: row.id,
        currentPath: row.worktreePath ?? null,
        location: cfg.worktreeLocation as string,
      })
      if (!nextPath) return
      writePath(kind, row.id, nextPath)
      moved++
    }

    for (const f of d.select().from(schema.fixes).all() as any[]) {
      if (f.worktreePath) {
        try { await moveOne('fix', f) } catch (e) { console.error(`[recover] fix worktree 迁移失败 ${f.id}`, e) }
      }
    }
    for (const t of d.select().from(schema.featureTasks).all() as any[]) {
      if (t.worktreePath) {
        try { await moveOne('feature', t) } catch (e) { console.error(`[recover] feature worktree 迁移失败 ${t.id}`, e) }
      }
    }
    if (moved) console.log(`[recover] 迁移了 ${moved} 个持久 worktree 到项目 repo 内`)
    if (cleared) console.log(`[recover] 清空了 ${cleared} 条指向已消失 worktree 的路径（下次使用时按原分支重建）`)
  } catch (e) {
    console.error('[recover] worktree 启动迁移失败', e)
  }

  // 1) Review tasks: reset + clean the worktree (review worktrees are throwaway)
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
        await removeWorktree(proj?.localPath ?? null, cfg.reposDir as string, r.id, { location: cfg.worktreeLocation as string })
      }
      console.log(`[recover] 重置了 ${stuck.length} 个中断的审核任务并清理 worktree`)
    }
  } catch (e) {
    console.error('[recover] 审核任务启动恢复失败', e)
  }

  // 1.5) Interrupted comment posting (posting): the agent stage finished long ago and the findings are intact, only the
  // publish window died with the process. Reset to ready_to_post (no automatic retry — the post may already have reached
  // GitHub and retrying would duplicate the comment; let the user decide in the UI whether to post again).
  try {
    const stuck = d.select().from(schema.reviews).where(eq(schema.reviews.status, 'posting' as any)).all()
    for (const r of stuck as any[]) {
      d.update(schema.reviews).set({ status: 'ready_to_post', updatedAt: now() }).where(eq(schema.reviews.id, r.id)).run()
    }
    if (stuck.length) console.log(`[recover] 重置了 ${stuck.length} 个中断的发布（posting → ready_to_post，请在 GitHub 确认后再决定是否重发）`)
  } catch (e) {
    console.error('[recover] posting 启动恢复失败', e)
  }

  // 2) Interrupted pushing: the push may already have reached GitHub (it just wasn't written back to the DB).
  // Reconcile origin/<branch> against fixHeadSha: equal = it succeeded → pushed; otherwise → error (the user re-uploads;
  // push is idempotent and has no side effects).
  try {
    const stuck = d.select().from(schema.fixes).where(eq(schema.fixes.status, 'pushing' as any)).all()
    for (const f of stuck as any[]) {
      let pushed = false
      // Compare against the worktree's real HEAD rather than fixHeadSha from the DB: when the commit finished but the
      // crash came before writing it back, the DB value is stale, and reconciling with the stale value would read
      // "new commit locally, remote still old" as already pushed and thus lose that local commit.
      let localHead: string = f.fixHeadSha
      if (f.worktreePath && existsSync(f.worktreePath) && f.branch) {
        try { localHead = (await git(f.worktreePath, ['rev-parse', 'HEAD'])).stdout.trim() || f.fixHeadSha } catch { /* fall back to the DB value */ }
        try {
          const { stdout } = await git(f.worktreePath, ['ls-remote', 'origin', f.branch])
          const remoteSha = stdout.trim().split(/\s+/)[0] || ''
          pushed = !!remoteSha && !!localHead && remoteSha === localHead
        } catch { /* network/remote unreachable → treat as not pushed */ }
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

  // 3) Interrupted chat turns: assistant turns still streaming → stopped. The changes stay in the worktree (uncommitted),
  // and next time it's opened the dirty check makes the upload button appear.
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

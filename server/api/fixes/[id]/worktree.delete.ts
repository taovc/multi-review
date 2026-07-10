import { eq } from 'drizzle-orm'
import { schema } from '~core/db/client'
import { removeWorktree } from '~core/git/worktree'
import { isChatting } from '~core/fix/pipeline'
import { getPrAutomationRow, pausePr } from '~core/automation/state'

// 只删本地 worktree 目录释放磁盘，保留 fix 记录与结果（区别于 discard：discard 连记录一起删）。
// PR 合并后清残留就用这个。进行中 / 对话中不可删（worktree 正被 agent 用）。
// 删后清空 worktree 相关的三个字段：worktree_path（目录）+ base_head_sha（diff 基线）
// + fix_head_sha（本地 commit，未 push 时随目录一起没了，留着会让 hasUnpushed 误报）。
// 同时清空两个会话 id（session_id=claude / codex_session_id=codex）：工作区都没了，对话所基于的
// 代码上下文也没了，下次再聊应从干净会话开始，避免 resume 一段「记得的改动已不存在」的旧对话。
// last_push_sha 保留（已 push 的历史，reply 仍会用）。下次跑验证/修复时 ensureWorktree 按分支重建。
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const cfg = useRuntimeConfig()
  const d = db()
  const fix = d.select().from(schema.fixes).where(eq(schema.fixes.id, id)).get()
  if (!fix) throw createError({ statusCode: 404, statusMessage: 'fix 不存在' })
  if (fix.status === 'pushing') {
    throw createError({ statusCode: 409, statusMessage: '上传进行中，请等它完成' })
  }
  if (isChatting(id)) throw createError({ statusCode: 409, statusMessage: '对话进行中，请等它完成或停止' })

  const project = d.select().from(schema.projects).where(eq(schema.projects.id, fix.projectId)).get()
  await removeWorktree(project?.localPath ?? null, cfg.reposDir as string, id).catch(() => {})
  const now = new Date().toISOString()
  d.update(schema.fixes)
    .set({ worktreePath: null, baseHeadSha: null, fixHeadSha: null, sessionId: null, codexSessionId: null, updatedAt: now })
    .where(eq(schema.fixes.id, id))
    .run()
  // worktree 没了，自动修复再 push 只会撞前置错误。这条 PR 有自动化状态就顺手关掉它（清 pendingFix + 两开关），
  // 引擎下轮 both-off 干净停手，不冒误导性的 push_error。用户可随时再开（再开会清零重跑 + 重建 worktree）。
  if (getPrAutomationRow(d, schema, fix.projectId, fix.prNumber)) {
    pausePr(d, schema, fix.projectId, fix.prNumber, now)
  }
  return { ok: true }
})

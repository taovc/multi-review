import { eq } from 'drizzle-orm'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { writeFile, rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { schema } from '~core/db/client'
import { isFeatureBusy } from '~core/feature/pipeline'
import { PlanSchema } from '~core/agent/featurePlan'
import { fixChangesDiff, fixChangesStat } from '~core/fix/changes'

const pexec = promisify(execFile)
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._\-/]*$/ // 注：分支生成已 slugify 成纯 [a-z0-9/-]，这里仅防注入/路径穿越

// 开 PR = feature 闭环终点：commit(英文 conventional) + push 新分支 + gh pr create。
// dryRun=true → 返回待提交 diff + 默认标题/正文(来自方案)，不落地。永远手动触发。
const Body = z.object({ dryRun: z.boolean().default(false), title: z.string().max(200).optional(), body: z.string().max(20000).optional() })

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const { dryRun, title, body } = Body.parse((await readBody(event).catch(() => ({}))) || {})
  const d = db()
  const task = d.select().from(schema.featureTasks).where(eq(schema.featureTasks.id, id)).get()
  if (!task) throw createError({ statusCode: 404, statusMessage: 'feature 任务不存在' })
  if (isFeatureBusy(id)) throw createError({ statusCode: 409, statusMessage: '正在实现中，请等它完成或停止' })
  if (!task.worktreePath || !existsSync(task.worktreePath)) throw createError({ statusCode: 400, statusMessage: 'worktree 不在了' })
  if (!task.branch || !SAFE_REF.test(task.branch)) throw createError({ statusCode: 400, statusMessage: `分支名不合法: ${task.branch}` })
  const project = d.select().from(schema.projects).where(eq(schema.projects.id, task.projectId)).get()
  if (!project) throw createError({ statusCode: 404, statusMessage: '项目不存在' })

  const wt = task.worktreePath
  const git = (args: string[]) => pexec('git', ['-C', wt, ...args], { maxBuffer: 64 * 1024 * 1024 })
  const now = () => new Date().toISOString()
  let plan: ReturnType<typeof PlanSchema.parse> | null = null
  try { plan = task.planJson ? PlanSchema.parse(JSON.parse(task.planJson)) : null } catch { /* 坏 JSON → null */ }
  const base = task.baseBranch || project.defaultBranch
  const defTitle = (title || plan?.prTitle || task.title || task.branch).trim()
  const defBody = (body ?? plan?.prBody ?? '')

  // ── 预览 ──
  if (dryRun) {
    const [{ diff, truncated }, stat] = await Promise.all([
      fixChangesDiff(wt).catch(() => ({ diff: '', truncated: false })),
      fixChangesStat(wt).catch(() => ({ filesChanged: 0, additions: 0, deletions: 0 })),
    ])
    return { dryRun: true, diff, truncated, title: defTitle, body: defBody, branch: task.branch, base, ...stat }
  }

  // 已开过就直接返回
  if (task.status === 'opened' && task.prUrl) return { ok: true, url: task.prUrl, number: task.prNumber }
  if (!['built', 'error'].includes(task.status)) throw createError({ statusCode: 409, statusMessage: `当前状态（${task.status}）不能开 PR` })

  // 真没东西可开就别推空分支 / 开空 PR（这一步在 try 外，干净返回 400，不把状态写成 error）。
  const { stdout: porcelain } = await git(['status', '--porcelain'])
  const dirty = !!porcelain.trim()
  if (!dirty) {
    const { stdout: ahead } = await git(['rev-list', '--count', `origin/${base}..HEAD`]).catch(() => ({ stdout: '0' }))
    if ((Number(ahead.trim()) || 0) === 0) throw createError({ statusCode: 400, statusMessage: 'worktree 没有任何改动，无法开 PR' })
  }

  // 不在这里把状态改成 building（会和实现阶段撞名，且开 PR 中途崩溃会卡住）；保持 built，成功→opened / 失败→error。
  try {
    if (dirty) {
      await git(['add', '-A'])
      await git(['commit', '-m', defTitle])
    }
    await git(['push', '-u', 'origin', `HEAD:${task.branch}`])

    // gh pr create（正文走临时文件，避免超长参数）
    const dir = await mkdtemp(join(tmpdir(), 'mr-feat-pr-'))
    const file = join(dir, 'body.md')
    await writeFile(file, defBody || defTitle)
    let url = ''
    try {
      const { stdout } = await pexec('gh', ['pr', 'create', '--repo', project.repo, '--base', base, '--head', task.branch, '--title', defTitle, '--body-file', file], { timeout: 60_000 })
      url = stdout.trim().split('\n').filter(Boolean).pop() || ''
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
    const num = Number(url.match(/\/pull\/(\d+)/)?.[1]) || null
    d.update(schema.featureTasks).set({ status: 'opened', prUrl: url || null, prNumber: num, error: null, updatedAt: now() }).where(eq(schema.featureTasks.id, id)).run()
    return { ok: true, url, number: num }
  } catch (e: any) {
    const m = String(e?.stderr || e?.message || '').slice(0, 400)
    d.update(schema.featureTasks).set({ status: 'error', error: `开 PR 失败: ${m}`, updatedAt: now() }).where(eq(schema.featureTasks.id, id)).run()
    throw createError({ statusCode: 500, statusMessage: `开 PR 失败: ${m}` })
  }
})

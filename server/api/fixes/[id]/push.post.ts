import { eq, and, inArray } from 'drizzle-orm'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import { schema } from '~core/db/client'
import { fetchReviewsCount } from '~core/github/gh'
import { isChatting } from '~core/fix/pipeline'
import { fixChangesDiff, fixChangesStat, hasUploadable } from '~core/fix/changes'
import { genCommitMessage } from '~core/fix/commitmsg'
import { assertCodexAheadCommitSafe, assertCodexCommitSafe } from '~core/fix/codexCommitSafety'

const pexec = promisify(execFile)
// First character must be alphanumeric (no leading `-`/`.`, so it can't be taken as a git flag or traverse paths)
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._\-/]*$/
const UPLOADABLE = ['open', 'ready', 'pushed', 'error'] as const

// "Commit and upload": `git add -A && commit && push` the (uncommitted) changes Claude made in the worktree to the PR branch.
// dryRun=true → return the pending diff + a conventional commit message generated from that diff + stats (no commit, no push), for the preview view.
// dryRun=false → really commit and push; message comes from the preview (possibly edited), generated on the spot when absent.
// Always manually triggered + an explicit confirmation step.
const Body = z.object({ dryRun: z.boolean().default(false), message: z.string().max(500).optional() })

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const cfg = useRuntimeConfig()
  const { dryRun, message } = Body.parse((await readBody(event).catch(() => ({}))) || {})
  const d = db()
  const fix = d.select().from(schema.fixes).where(eq(schema.fixes.id, id)).get()
  if (!fix) throw createError({ statusCode: 404, statusMessage: 'fix 不存在' })
  if (isChatting(id)) throw createError({ statusCode: 409, statusMessage: '对话正在进行，请等它完成或停止再上传' })
  if (!fix.worktreePath || !existsSync(fix.worktreePath)) throw createError({ statusCode: 400, statusMessage: 'worktree 不在了' })
  if (!SAFE_REF.test(fix.branch)) throw createError({ statusCode: 400, statusMessage: `分支名不合法: ${fix.branch}` })
  const project = d.select().from(schema.projects).where(eq(schema.projects.id, fix.projectId)).get()
  if (!project) throw createError({ statusCode: 404, statusMessage: '项目不存在' })

  const wt = fix.worktreePath
  const git = (args: string[]) => pexec('git', ['-C', wt, ...args], { maxBuffer: 64 * 1024 * 1024 })
  const now = () => new Date().toISOString()

  // Merge in progress? (the agent ran `git merge --no-commit`, resolved the conflicts and left MERGE_HEAD behind).
  // If so the commit message should keep the "Merge ... into HEAD" that git prepared, instead of an AI summary of the diff.
  const mergeState = async (): Promise<{ merging: boolean; msg: string }> => {
    const merging = await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD']).then(() => true).catch(() => false)
    if (!merging) return { merging: false, msg: '' }
    let msg = ''
    try {
      const p = (await git(['rev-parse', '--git-path', 'MERGE_MSG'])).stdout.trim()
      msg = (await readFile(resolve(wt, p), 'utf8')).trim()
    } catch { /* unreadable → leave it empty and commit with --no-edit so git fills in the merge message itself */ }
    return { merging: true, msg }
  }

  // Anything to upload? Either the worktree is dirty (uncommitted changes) or the local HEAD is ahead of origin/<branch>
  // (committed but not pushed, including commits Claude made itself)
  const { dirty, ahead } = await hasUploadable(wt, fix.branch)
  if (!dirty && !ahead) throw createError({ statusCode: 400, statusMessage: '没有可上传的改动' })

  // ── Preview: pending diff + generated commit message + stats, no commit and no push ──
  if (dryRun) {
    const [{ diff, truncated }, stat] = await Promise.all([
      fixChangesDiff(wt).catch(() => ({ diff: '', truncated: false })),
      fixChangesStat(wt).catch(() => ({ filesChanged: 0, additions: 0, deletions: 0 })),
    ])
    // Merge commit: use git's merge message and skip the AI generation; ordinary changes: AI summary of the diff
    const { merging, msg: mergeMsg } = await mergeState()
    const genMsg = !dirty ? '' : merging ? (mergeMsg || `Merge into ${fix.branch}`) : await genCommitMessage(cfg.translateModel as string, diff, wt)
    // needsCommit=false: no uncommitted changes, the local HEAD is merely ahead of the remote (e.g. the last push failed) → just re-push, no commit message needed
    return { dryRun: true, diff, truncated, message: genMsg, needsCommit: dirty, isMerge: merging, ...stat }
  }

  // ── For real: CAS-claim the lock → pushing, commit (only when dirty) + push ──
  if (!(UPLOADABLE as readonly string[]).includes(fix.status)) throw createError({ statusCode: 409, statusMessage: `当前状态（${fix.status}）不能上传` })
  const claimed = d
    .update(schema.fixes)
    .set({ status: 'pushing', error: null, updatedAt: now() })
    .where(and(eq(schema.fixes.id, id), inArray(schema.fixes.status, UPLOADABLE)))
    .run()
  if (!claimed.changes) throw createError({ statusCode: 409, statusMessage: '该修复正在上传或状态已变，请刷新' })

  try {
    const { merging } = await mergeState()
    if (project.provider === 'codex') {
      // Changes brought in by a merge come from the base branch (codex didn't write them) → skip the protected-file check; ordinary changes are still checked.
      if (dirty && !merging) {
        const { stdout: porcelain } = await git(['status', '--porcelain'])
        assertCodexCommitSafe(porcelain)
      }
      if (ahead) {
        const [{ stdout: head }, { stdout: nameStatus }] = await Promise.all([
          git(['rev-parse', 'HEAD']),
          git(['diff', '--name-status', `origin/${fix.branch}..HEAD`]),
        ])
        assertCodexAheadCommitSafe({
          currentHead: head.trim() || null,
          fixHeadSha: fix.fixHeadSha ?? null,
          nameStatus,
        })
      }
    }
    if (dirty) {
      await git(['add', '-A'])
      const userMsg = (message || '').trim()
      if (userMsg) {
        // The message the user confirmed/edited in the preview (during a merge it defaults to git's merge message).
        // Committing mid-merge still produces a two-parent merge commit; -m only decides the message.
        await git(['commit', '-m', userMsg])
      } else {
        if (merging) {
          await git(['commit', '--no-edit']) // use the MERGE_MSG git prepared (Merge ... into HEAD)
        } else {
          const { diff } = await fixChangesDiff(wt).catch(() => ({ diff: '' }))
          await git(['commit', '-m', await genCommitMessage(cfg.translateModel as string, diff, wt)])
        }
      }
    }
    const { stdout: head } = await git(['rev-parse', 'HEAD'])
    const headSha = head.trim()
    // Persist fixHeadSha first (status still pushing): if we crash after the push but before writing pushed, recovery uses origin==fixHeadSha to decide it succeeded
    d.update(schema.fixes).set({ fixHeadSha: headSha, updatedAt: now() }).where(eq(schema.fixes.id, id)).run()

    await git(['push', 'origin', `HEAD:${fix.branch}`])

    // Record the current review count at push time as a baseline (for "review updated"). Failing to fetch it is not fatal.
    const reviewsAtPush = await fetchReviewsCount(project.repo, fix.prNumber).catch(() => null)
    const stat = await fixChangesStat(wt).catch(() => ({ filesChanged: fix.filesChanged ?? 0, additions: fix.additions ?? 0, deletions: fix.deletions ?? 0 }))
    d.update(schema.fixes)
      .set({ status: 'pushed', error: null, fixHeadSha: headSha, lastPushSha: headSha, lastActionKind: 'pushed', reviewsAtPush, pushedAt: now(), lastUploadAt: now(), ...stat, updatedAt: now() })
      .where(eq(schema.fixes.id, id))
      .run()
    return { ok: true, sha: headSha.slice(0, 7), url: `https://github.com/${project.repo}/pull/${fix.prNumber}` }
  } catch (e: any) {
    const m = String(e?.stderr || e?.message || '').slice(0, 400)
    d.update(schema.fixes).set({ status: 'error', error: `上传失败: ${m}`, updatedAt: now() }).where(eq(schema.fixes.id, id)).run()
    throw createError({ statusCode: 500, statusMessage: `上传失败: ${m}` })
  }
})

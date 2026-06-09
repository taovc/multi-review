import { eq, and, inArray } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { schema } from '~core/db/client'
import { enqueueFix } from '~core/fix/pipeline'
import { reviewQueue } from '~core/queue'
import { fetchPrMeta } from '~core/github/gh'

// Lance un agent qui corrige ma PR à partir des commentaires (toggles fix/simplify/tests/testsUI).
export default defineEventHandler(async (event) => {
  const projectId = getRouterParam(event, 'id')!
  const prNumber = Number(getRouterParam(event, 'number'))
  if (!Number.isInteger(prNumber)) throw createError({ statusCode: 400, statusMessage: 'PR 号无效' })
  const body = await readBody(event).catch(() => ({}))
  const steps = {
    fix: body?.steps?.fix !== false,
    simplify: body?.steps?.simplify !== false,
    tests: body?.steps?.tests !== false,
    testsUI: body?.steps?.testsUI !== false,
  }

  const cfg = useRuntimeConfig()
  const d = db()
  const project = d.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()
  if (!project) throw createError({ statusCode: 404, statusMessage: '项目不存在' })
  if (!project.localPath) throw createError({ statusCode: 400, statusMessage: '项目未配置本地 clone 路径' })

  // déjà un fix en cours sur cette PR ?
  const inflight = d
    .select({ id: schema.fixes.id })
    .from(schema.fixes)
    .where(and(eq(schema.fixes.projectId, projectId), eq(schema.fixes.prNumber, prNumber), inArray(schema.fixes.status, ['queued', 'running', 'pushing'])))
    .get()
  if (inflight) throw createError({ statusCode: 409, statusMessage: '该 PR 已有修复在进行中' })

  // branche de la PR (le worktree la checkout)
  let branch: string
  try {
    branch = (await fetchPrMeta(project.repo, prNumber)).branch
  } catch (e) {
    throw createError({ statusCode: 502, statusMessage: (e as Error).message })
  }
  if (!branch) throw createError({ statusCode: 400, statusMessage: '无法获取 PR 分支' })

  const now = new Date().toISOString()
  const fixId = nanoid()
  d.insert(schema.fixes)
    .values({ id: fixId, projectId, prNumber, branch, steps: JSON.stringify(steps), status: 'queued', createdAt: now, updatedAt: now })
    .run()

  reviewQueue.setLimit(Number(cfg.maxConcurrency) || 3)
  const rc = resolveReviewConfig(d, project)
  enqueueFix({
    db: d,
    schema,
    fixId,
    repo: project.repo,
    prNumber,
    branch,
    defaultBranch: project.defaultBranch,
    localPath: project.localPath,
    reposDir: cfg.reposDir as string,
    model: rc.model,
    steps,
  })
  return { fixId, status: 'queued' }
})

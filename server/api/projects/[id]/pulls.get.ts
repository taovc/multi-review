import { eq } from 'drizzle-orm'
import { schema } from '~core/db/client'
import { listMyPulls, listPulls } from '~core/github/gh'

// 分页拉该项目仓库的 PR（GraphQL cursor），标注哪些已建审核任务。
// author=@me 时只拉本人 PR（Search API），并带上评论/未解决讨论数（「我的 PR」标签页用）。
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const query = getQuery(event)
  const state = (query.state as string) || 'open'
  const validState = (['open', 'closed', 'merged', 'all'] as const).includes(state as any)
    ? (state as 'open' | 'closed' | 'merged' | 'all')
    : 'open'
  const first = Math.min(Number(query.first) || 20, 50)
  const after = (query.after as string) || null
  const mine = query.author === '@me'

  const d = db()
  const project = d.select().from(schema.projects).where(eq(schema.projects.id, id)).get()
  if (!project) throw createError({ statusCode: 404, statusMessage: '项目不存在' })

  let page
  try {
    page = mine
      ? await listMyPulls(project.repo, validState, first, after)
      : await listPulls(project.repo, validState, first, after)
  } catch (e) {
    throw createError({ statusCode: 502, statusMessage: (e as Error).message })
  }

  const tasks = d
    .select({ id: schema.reviews.id, prNumber: schema.reviews.prNumber, status: schema.reviews.status })
    .from(schema.reviews)
    .where(eq(schema.reviews.projectId, id))
    .all()
  const taskByPr = new Map(tasks.map((t) => [t.prNumber, t]))

  return {
    pulls: page.pulls.map((p) => {
      const task = taskByPr.get(p.number)
      return { ...p, hasTask: !!task, taskId: task?.id ?? null, taskStatus: task?.status ?? null }
    }),
    totalCount: page.totalCount,
    hasNextPage: page.hasNextPage,
    endCursor: page.endCursor,
  }
})

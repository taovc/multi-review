import { eq } from 'drizzle-orm'
import { schema } from '~core/db/client'
import { fetchPrDetail, fetchTimeline } from '~core/github/gh'

// Timeline (main view): PR metadata + description + changed files + the full timeline (comments/reviews/commits/deployments…)
// The diff is not here (heavy, lazy-loaded — see diff.get.ts)
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const number = Number(getRouterParam(event, 'number'))
  if (!number) throw createError({ statusCode: 400, statusMessage: 'PR number 无效' })

  const d = db()
  const project = d.select().from(schema.projects).where(eq(schema.projects.id, id)).get()
  if (!project) throw createError({ statusCode: 404, statusMessage: '项目不存在' })

  try {
    const [detail, nodes] = await Promise.all([
      fetchPrDetail(project.repo, number),
      fetchTimeline(project.repo, number),
    ])
    return { detail, nodes }
  } catch (e) {
    throw createError({ statusCode: 502, statusMessage: (e as Error).message })
  }
})

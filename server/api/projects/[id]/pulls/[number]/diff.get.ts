import { eq } from 'drizzle-orm'
import { schema } from '~core/db/client'
import { fetchPrDiff } from '~core/github/gh'

// Full diff (lazy: only fetched when the drawer switches to the "changes" sub-tab)
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const number = Number(getRouterParam(event, 'number'))
  if (!number) throw createError({ statusCode: 400, statusMessage: 'PR number 无效' })

  const d = db()
  const project = d.select().from(schema.projects).where(eq(schema.projects.id, id)).get()
  if (!project) throw createError({ statusCode: 404, statusMessage: '项目不存在' })

  try {
    const { diff, truncated } = await fetchPrDiff(project.repo, number)
    return { diff, truncated }
  } catch (e) {
    throw createError({ statusCode: 502, statusMessage: (e as Error).message })
  }
})

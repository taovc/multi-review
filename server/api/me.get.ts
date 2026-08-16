import { getCurrentUserLogin } from '~core/github/gh'

// Currently logged-in GitHub user (the identity inherited from the gh CLI), used by the "my PRs" filter.
export default defineEventHandler(async () => {
  try {
    return { login: await getCurrentUserLogin() }
  } catch (e) {
    throw createError({ statusCode: 502, statusMessage: (e as Error).message })
  }
})

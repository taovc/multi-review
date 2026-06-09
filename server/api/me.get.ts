import { getCurrentUserLogin } from '~core/github/gh'

// 当前登录的 GitHub 用户（gh CLI 继承的身份），供「我的 PR」过滤用。
export default defineEventHandler(async () => {
  try {
    return { login: await getCurrentUserLogin() }
  } catch (e) {
    throw createError({ statusCode: 502, statusMessage: (e as Error).message })
  }
})

import { ghToken } from '~core/github/gh'

// Images in private-repo GitHub comments (github.com/user-attachments/... or
// *.githubusercontent.com) 404 when the browser fetches them directly (they need a GitHub session).
// Here we fetch them with the gh token and relay them to the frontend.
// The allowlist is strictly limited to GitHub image domains to prevent SSRF (this must not become a
// general-purpose proxy into the intranet).
const ALLOW = /^https:\/\/(github\.com\/user-attachments\/|[a-z0-9-]+\.githubusercontent\.com\/)/i

export default defineEventHandler(async (event) => {
  const u = getQuery(event).u as string
  if (!u || !ALLOW.test(u)) throw createError({ statusCode: 400, statusMessage: '不允许的图片地址' })

  const token = await ghToken()
  const res = await fetch(u, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    redirect: 'follow',
  }).catch(() => null)
  if (!res || !res.ok) throw createError({ statusCode: res?.status || 502, statusMessage: '取图失败' })

  const ct = res.headers.get('content-type') || 'application/octet-stream'
  if (!ct.startsWith('image/')) throw createError({ statusCode: 415, statusMessage: '不是图片' })
  setHeader(event, 'content-type', ct)
  setHeader(event, 'cache-control', 'private, max-age=3600')
  return Buffer.from(await res.arrayBuffer())
})

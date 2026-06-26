import { desc, count } from 'drizzle-orm'
import { schema } from '~core/db/client'

// 全局会话历史列表：按最近使用倒序 + 翻页。?page=0&pageSize=20
export default defineEventHandler((event) => {
  const q = getQuery(event)
  const pageSize = Math.min(Math.max(Number(q.pageSize) || 20, 1), 100)
  const page = Math.max(Number(q.page) || 0, 0)
  const d = db()
  const total = d.select({ c: count() }).from(schema.globalSessions).get()?.c ?? 0
  const sessions = d
    .select()
    .from(schema.globalSessions)
    .orderBy(desc(schema.globalSessions.lastUsedAt))
    .limit(pageSize)
    .offset(page * pageSize)
    .all()
  return { sessions, total, page, pageSize, hasNext: (page + 1) * pageSize < total }
})

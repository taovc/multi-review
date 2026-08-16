import { nanoid } from 'nanoid'
import { eq } from 'drizzle-orm'

// Single writer for append-only chat turns: look up the current max seq → insert one user turn (done) plus one
// assistant placeholder turn (streaming).
// The fix/global/feature pipelines each carried an identical copy of this logic; extracted here to share.
// turnTable is a drizzle table object and fkField is its foreign-key property name ('fixId' / 'sessionId' / 'taskId') —
// a drizzle table object resolves a property name to a column object, so turnTable[fkField] works both in where and as a values key.
export function appendTurns(opts: {
  db: any
  turnTable: any
  fkField: string
  fkValue: string
  now: () => string
  message: string
}): { userId: string; assistantId: string } {
  const { db, turnTable, fkField, fkValue, now, message } = opts
  const col = turnTable[fkField]
  const maxSeq = (db.select().from(turnTable).where(eq(col, fkValue)).all() as { seq: number }[])
    .reduce((m, t) => Math.max(m, t.seq), 0)
  const userId = nanoid()
  const assistantId = nanoid()
  db.insert(turnTable).values({ id: userId, [fkField]: fkValue, seq: maxSeq + 1, role: 'user', content: message, status: 'done', createdAt: now() }).run()
  db.insert(turnTable).values({ id: assistantId, [fkField]: fkValue, seq: maxSeq + 2, role: 'assistant', content: '', status: 'streaming', createdAt: now() }).run()
  return { userId, assistantId }
}

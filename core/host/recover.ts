import { and, eq, inArray, lt } from 'drizzle-orm'

// Startup recovery of the session hosts' persisted state. A process that died took its parked prompts and running
// turns with it: prompts created before this boot can never be answered → expired; runs it left 'running' /
// 'awaiting_input' → stopped (the native transcript is on disk, the next message resumes it). Only rows older than
// `bootAt` are touched: the caller may run this asynchronously while new requests already create rows.
export function recoverHostState(db: any, schema: any, bootAt: string, now = new Date().toISOString()): { expiredPrompts: number; stoppedRuns: number } {
  const expired = db.update(schema.permissionRequests).set({ status: 'expired', resolvedAt: now })
    .where(and(eq(schema.permissionRequests.status, 'pending'), lt(schema.permissionRequests.createdAt, bootAt))).run()
  const settled = db.update(schema.runs).set({ status: 'stopped', error: null, updatedAt: now })
    .where(and(inArray(schema.runs.status, ['running', 'awaiting_input']), lt(schema.runs.updatedAt, bootAt))).run()
  return { expiredPrompts: Number(expired.changes ?? 0), stoppedRuns: Number(settled.changes ?? 0) }
}

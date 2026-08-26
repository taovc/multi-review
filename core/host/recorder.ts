import { nanoid } from 'nanoid'
import { eq, sql } from 'drizzle-orm'
import { cockpitBus } from '../events'
import { eventMessage, persistedEvent, type RunEvent } from './types'

// Fan-out for RunEvents: the live bus channel `run:<id>` (SSE) + the run_events table (everything but deltas).
export const runChannel = (runId: string) => `run:${runId}`

export function makeRunEmitter(o: { runId: string; db?: any; schema?: any; turnId: () => string | null }) {
  return (e: RunEvent) => {
    const ts = new Date().toISOString()
    try { cockpitBus.emit({ reviewId: runChannel(o.runId), ts, kind: 'run', message: eventMessage(e) ?? undefined, data: e }) } catch { /* subscriber errors are isolated */ }
    if (!persistedEvent(e) || !o.db || !o.schema) return
    try {
      const seqRow = o.db.select({ m: sql<number>`COALESCE(MAX(${o.schema.runEvents.seq}), 0)` }).from(o.schema.runEvents).where(eq(o.schema.runEvents.runId, o.runId)).get()
      const seq = Number(seqRow?.m ?? 0) + 1
      const data = e.t === 'tool_result' ? { ...e, output: e.output.slice(0, 32_000) }
        : e.t === 'thinking' ? { ...e, text: e.text.slice(0, 4_000) }
        : e.t === 'tool_use' ? { ...e, input: boundedInput(e.input) }
        : e
      o.db.insert(o.schema.runEvents).values({
        id: nanoid(), runId: o.runId, seq, turnId: o.turnId(), ts, kind: e.t, message: eventMessage(e), data: JSON.stringify(data),
        toolUseId: e.t === 'tool_use' || e.t === 'tool_result' ? e.id : null,
      }).run()
    } catch (err) { console.warn('[host] persist event failed', (err as Error).message) }
  }
}

// Tool inputs can carry whole files (Write/Edit): keep a preview, never the full payload, in run_events.
function boundedInput(input: unknown): unknown {
  try {
    const s = JSON.stringify(input)
    return s.length > 32_000 ? { _truncated: true, _length: s.length, preview: s.slice(0, 32_000) } : input
  } catch { return String(input) }
}

export function setRunStatus(db: any, schema: any, runId: string, status: 'running' | 'awaiting_input' | 'idle' | 'stopped' | 'error', extra: Record<string, unknown> = {}): void {
  if (!db || !schema) return
  try { db.update(schema.runs).set({ status, updatedAt: new Date().toISOString(), ...extra }).where(eq(schema.runs.id, runId)).run() } catch { /* ignore */ }
}

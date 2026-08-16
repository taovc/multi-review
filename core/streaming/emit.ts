import { nanoid } from 'nanoid'
import { cockpitBus } from '../events'

// Unified progress event emitter: pushes live to cockpitBus (channel = channel) and optionally persists non-'text' events to an event table.
// 'text' is the token stream (high frequency) — live only, never persisted. fix/feature persist (to their own *_events), global does not (no eventTable passed).
// fkField/fkValue are the event table's foreign-key column name and value ('fixId'/'taskId'); drizzle tables address columns by property name, so [fkField] is used as the values key.
export function makeEmit(opts: {
  channel: string
  now: () => string
  db?: any
  eventTable?: any
  fkField?: string
  fkValue?: string
}): (kind: string, message?: string) => void {
  const { channel, now, db, eventTable, fkField, fkValue } = opts
  return (kind: string, message?: string) => {
    const ts = now()
    cockpitBus.emit({ reviewId: channel, ts, kind, message })
    if (kind !== 'text' && db && eventTable && fkField) {
      try {
        db.insert(eventTable).values({ id: nanoid(), [fkField]: fkValue, ts, kind, message: message ?? null }).run()
      } catch { /* a failed insert doesn't affect the main flow */ }
    }
  }
}

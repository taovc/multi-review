// Progress bus: the core engine emits, the SSE endpoints subscribe, routed by reviewId.
export type CockpitEvent = {
  reviewId: string
  ts: string
  kind: string // stage|finding|error|posted|recheck|done|...
  message?: string
  data?: unknown
}

type Handler = (e: CockpitEvent) => void

class EventBus {
  private subs = new Map<string, Set<Handler>>()

  subscribe(reviewId: string, handler: Handler): () => void {
    let set = this.subs.get(reviewId)
    if (!set) {
      set = new Set()
      this.subs.set(reviewId, set)
    }
    set.add(handler)
    return () => {
      set!.delete(handler)
      if (set!.size === 0) this.subs.delete(reviewId)
    }
  }

  emit(e: CockpitEvent) {
    const set = this.subs.get(e.reviewId)
    if (!set) return
    for (const h of set) {
      try {
        h(e)
      } catch {
        // one subscriber throwing must not affect the others
      }
    }
  }
}

// HMR-safe singleton
const g = globalThis as unknown as { __cockpitBus?: EventBus }
export const cockpitBus = g.__cockpitBus ?? (g.__cockpitBus = new EventBus())

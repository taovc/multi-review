import type { ReviewProvider } from './runners'

// Which column the resume session id goes in: claude uses sessionId, codex uses codexSessionId
// (each stores its own, so switching provider never mixes them up).
// The fix and feature pipelines each carried an identical copy of this closure; extracted to share.
export type SessionFields = { sessionId?: string | null; codexSessionId?: string | null }

// provider can be undefined (it's optional in the fix ctx) → treated as claude (same behavior as the `=== 'codex'` check before the extraction).
export function sessionFields(provider: ReviewProvider | undefined, sid: string | null): SessionFields {
  return provider === 'codex' ? { codexSessionId: sid } : { sessionId: sid }
}

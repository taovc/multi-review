import assert from 'node:assert/strict'
import { sessionFields } from '../core/agent/session'

// claude → writes only sessionId; codex → writes only codexSessionId (each stored separately, never mixed when switching provider)
assert.deepEqual(sessionFields('claude', 'abc'), { sessionId: 'abc' })
assert.deepEqual(sessionFields('codex', 'thr_1'), { codexSessionId: 'thr_1' })
assert.deepEqual(sessionFields('claude', null), { sessionId: null })
assert.deepEqual(sessionFields('codex', null), { codexSessionId: null })

// No cross-contamination: the claude result has no codexSessionId key, and vice versa
assert.equal('codexSessionId' in sessionFields('claude', 'x'), false)
assert.equal('sessionId' in sessionFields('codex', 'x'), false)

console.log('session-fields: ok')

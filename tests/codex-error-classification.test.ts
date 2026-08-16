import assert from 'node:assert/strict'
import { classifyCodexError, formatCodexProviderError } from '../core/agent/codexErrors'

assert.equal(classifyCodexError(new Error('AbortError: The operation was aborted')), 'interrupted')
assert.equal(classifyCodexError(new Error('Codex Exec exited with signal SIGTERM')), 'interrupted')
assert.equal(classifyCodexError(new Error('No session found for thread id 123')), 'invalid_thread')
assert.equal(classifyCodexError(new Error('Conversation 123 not found')), 'invalid_thread')
// codex resume failed: no local rollout (session file) for that thread → treat it as a dead thread and retry on a new one
assert.equal(classifyCodexError(new Error('thread/resume failed: no rollout found for thread id 019efe44 (code -32600)')), 'invalid_thread')
assert.equal(classifyCodexError(new Error('401 Unauthorized: invalid api key')), 'auth')
assert.equal(classifyCodexError(new SyntaxError('Unexpected token n in JSON')), 'json')
assert.equal(classifyCodexError(new Error('sandbox runtime unavailable')), 'runtime')

assert.match(
  formatCodexProviderError('chat', new Error('No session found for thread id 123')),
  /thread could not be resumed/i,
)

assert.match(
  formatCodexProviderError('review', new Error('AbortError: The operation was aborted')),
  /interrupted/i,
)

import assert from 'node:assert/strict'
import { shouldRetryCodexChatWithoutThread } from '../core/agent/codexErrors'

assert.equal(shouldRetryCodexChatWithoutThread(new Error('No session found for thread id 123'), true), true)
assert.equal(shouldRetryCodexChatWithoutThread(new Error('No session found for thread id 123'), false), false)
assert.equal(shouldRetryCodexChatWithoutThread(new Error('401 Unauthorized'), true), false)

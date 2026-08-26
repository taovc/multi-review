import assert from 'node:assert/strict'
import { claudeHost, codexHost, hostFor, hostOf } from '../core/host'

// Chat turns are routed to a session host by provider; an unknown/absent provider means Claude.
assert.equal(hostFor(undefined), claudeHost)
assert.equal(hostFor('claude'), claudeHost)
assert.equal(hostFor('codex'), codexHost)
// A run that is live on neither host resolves to the Claude host (whose close()/info() are harmless no-ops).
assert.equal(hostOf('no-such-run'), claudeHost)

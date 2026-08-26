import assert from 'node:assert/strict'
import { getCodexSdkStatus } from '../core/agent/codexStatus'
import { resolveCodexExecutable } from '../core/codex/bin'
import { stopCodexServer } from '../core/codex/appServer'

// The vendored binary must resolve, and the status must come from a live app-server handshake.
assert.match(resolveCodexExecutable() || '', /codex/)

const status = await getCodexSdkStatus(true)

assert.equal(status.installed, true)
assert.match(status.cliVersion || '', /^\d+\.\d+\.\d+/)
assert.doesNotMatch(status.detail, /package subpath.*package\.json/i)
stopCodexServer()

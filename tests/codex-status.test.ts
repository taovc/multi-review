import assert from 'node:assert/strict'
import { getCodexSdkStatus } from '../core/agent/codexStatus'

const directImport = await import('@openai/codex-sdk')
assert.equal(typeof directImport.Codex, 'function')

const status = await getCodexSdkStatus(true)

assert.equal(status.installed, true)
assert.match(status.cliVersion || '', /^\d+\.\d+\.\d+/)
assert.doesNotMatch(status.detail, /package subpath.*package\.json/i)

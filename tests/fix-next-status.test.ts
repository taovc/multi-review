import assert from 'node:assert/strict'
import { computeFixNextStatus } from '../core/fix/status'

// has unpushed changes → ready (regardless of the current status)
assert.equal(computeFixNextStatus({ dirty: true, ahead: false, currentStatus: 'open' }), 'ready')
assert.equal(computeFixNextStatus({ dirty: false, ahead: true, currentStatus: 'pushed' }), 'ready')
assert.equal(computeFixNextStatus({ dirty: true, ahead: true, currentStatus: 'error' }), 'ready')

// no changes: already pushed before → stay pushed
assert.equal(computeFixNextStatus({ dirty: false, ahead: false, currentStatus: 'pushed' }), 'pushed')

// no changes + not pushed (including null/unknown) → fall back to open
assert.equal(computeFixNextStatus({ dirty: false, ahead: false, currentStatus: 'open' }), 'open')
assert.equal(computeFixNextStatus({ dirty: false, ahead: false, currentStatus: 'error' }), 'open')
assert.equal(computeFixNextStatus({ dirty: false, ahead: false, currentStatus: null }), 'open')
assert.equal(computeFixNextStatus({ dirty: false, ahead: false }), 'open')

console.log('fix-next-status: ok')

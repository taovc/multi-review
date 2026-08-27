import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { CodexRpc, RpcError } from '../core/codex/rpc'
import { EXPECTED_CODEX_VERSION } from '../core/codex/bin'
import { readFileSync } from 'node:fs'

// The JSON-RPC transport against the mock app-server: request/response pairing, notifications and server→client
// requests routed by shape, -32001 retry with backoff, error replies, and exit propagation.
const rpc = new CodexRpc(resolve('tests/helpers/mockCodexAppServer.mjs'), ['app-server', '--listen', 'stdio://'])
const notes: string[] = []
rpc.on('notification', (m) => notes.push(m))
let exited: [number | null, NodeJS.Signals | null] | null = null
rpc.on('exit', (code, signal) => { exited = [code, signal] })

try {
  const init = await rpc.request('initialize', { clientInfo: { name: 't', version: '0' }, capabilities: { experimentalApi: true } })
  assert.equal(init.userAgent, 'mock/9.9.9 (test)')
  rpc.notify('initialized', {})

  // Interleaved requests resolve to their own ids.
  const [a, b] = await Promise.all([rpc.request('echo', { n: 1 }), rpc.request('echo', { n: 2 })])
  assert.deepEqual(a, { echo: { n: 1 } })
  assert.deepEqual(b, { echo: { n: 2 } })

  // Error replies become RpcError with the server's code.
  await assert.rejects(rpc.request('bad', {}), (e: any) => e instanceof RpcError && e.code === -32000)

  // -32001 (overloaded) is retried until it succeeds, but not forever.
  const t0 = Date.now()
  const ok = await rpc.request('flaky', { failures: 2 })
  assert.equal(ok.attempts, 3)
  assert.ok(Date.now() - t0 >= 1200, 'the retries should have backed off')
  await assert.rejects(rpc.request('flaky', { failures: 10 }), (e: any) => e instanceof RpcError && e.code === -32001)

  // Notifications arrive by method; a thread/start emits thread/started.
  const st = await rpc.request('thread/start', { cwd: process.cwd(), approvalPolicy: 'never', sandbox: 'read-only' })
  assert.match(st.thread.id, /^t-/)
  await new Promise((r) => setTimeout(r, 50))
  assert.ok(notes.includes('thread/started'))

  // Timeout is per request.
  await assert.rejects(rpc.request('never-answered', {}, 200), /no response within 200ms|unknown method/)

  // Pinned version stays in sync with package.json.
  const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))
  assert.equal(String(pkg.dependencies['@openai/codex']).replace(/^[^\d]*/, ''), EXPECTED_CODEX_VERSION)
} finally {
  rpc.close()
  await new Promise((r) => setTimeout(r, 300))
}
assert.ok(exited, 'exit should have been observed after close()')
assert.equal(rpc.alive, false)
console.log('codex-rpc: ok')

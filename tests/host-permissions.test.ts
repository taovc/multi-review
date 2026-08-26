import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { getDb, schema } from '../core/db/client'
import { answerPending, makeDangerHook, makePromptBridge, toPermissionResult, type PendingPrompt } from '../core/host/permissions'
import { createRun } from '../core/runs/store'
import type { RunEvent } from '../core/host/types'

const d = getDb(':memory:')
const runId = createRun(d, schema, { kind: 'session', subkind: 'session', provider: 'claude' })

// ── Danger hook: dangerous Bash → 'ask' (a permission card in every mode); allowed → pass-through; non-Bash ignored ──
let allow = false
const hook = makeDangerHook(() => allow)
const pre = (cmd: string) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: cmd }, session_id: 's', transcript_path: '', cwd: '/' }) as any
const opts = { signal: new AbortController().signal }
assert.deepEqual(await hook(pre('ls -la'), 'tu', opts), {})
const pushed = await hook(pre('git -C /repo push origin main'), 'tu', opts) as any
assert.equal(pushed.hookSpecificOutput.permissionDecision, 'ask')
assert.equal((await hook(pre('sudo rm -rf /'), 'tu', opts) as any).hookSpecificOutput.permissionDecision, 'ask')
assert.equal((await hook(pre('gh --repo o/r pr create'), 'tu', opts) as any).hookSpecificOutput.permissionDecision, 'ask')
allow = true
assert.deepEqual(await hook(pre('git push'), 'tu', opts), {}, 'allowDanger is read live')
assert.deepEqual(await hook({ ...pre('git push'), tool_name: 'Write' }, 'tu', opts), {})
console.log('danger hook: ok')

// ── Answer → PermissionResult mapping ──
const base: Pick<PendingPrompt, 'kind' | 'input' | 'suggestions'> = { kind: 'tool', input: { command: 'touch x' }, suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'touch:*' }], behavior: 'allow', destination: 'localSettings' }] as any }
assert.deepEqual(toPermissionResult(base, { behavior: 'deny' }), { behavior: 'deny', message: 'Denied by the user in PR Cockpit', interrupt: false })
const once = toPermissionResult(base, { behavior: 'allow' }) as any
assert.equal(once.behavior, 'allow'); assert.equal(once.updatedPermissions, undefined); assert.equal(once.decisionClassification, 'user_temporary')
const always = toPermissionResult(base, { behavior: 'allow', always: true }) as any
assert.equal(always.updatedPermissions.length, 1); assert.equal(always.decisionClassification, 'user_permanent')
const q = toPermissionResult({ kind: 'question', input: { questions: [{ question: 'A or B?' }] } }, { behavior: 'answer', answers: { 'A or B?': 'A' } }) as any
assert.deepEqual(q.updatedInput.answers, { 'A or B?': 'A' })
assert.ok(Array.isArray(q.updatedInput.questions), 'original input is preserved alongside the answers')
console.log('permission result mapping: ok')

// ── Bridge round trip against the in-memory DB: park → row pending → answer → resolved + row updated ──
const events: RunEvent[] = []
const prompts = new Map<string, PendingPrompt>()
let waiting: boolean | null = null
const bridge = makePromptBridge({ runId, store: { db: d, schema }, prompts, currentTurnId: () => 'turn-1', emit: (e) => events.push(e), onWaiting: (w) => { waiting = w } })
const ac = new AbortController()
const p = bridge('Bash', { command: 'touch x' }, { signal: ac.signal, suggestions: base.suggestions, title: 'Claude wants to run touch x' } as any)
await new Promise((r) => setTimeout(r, 5))
assert.equal(prompts.size, 1)
assert.equal(waiting, true)
const req = events.find((e) => e.t === 'permission_request') as any
assert.equal(req.kind, 'tool'); assert.equal(req.title, 'Claude wants to run touch x')
let row = d.select().from(schema.permissionRequests).where(eq(schema.permissionRequests.id, req.promptId)).get()!
assert.equal(row.status, 'pending'); assert.equal(row.turnId, 'turn-1'); assert.equal(JSON.parse(row.input!).command, 'touch x')
assert.equal(answerPending(prompts, { db: d, schema }, (e) => events.push(e), 'nope', { behavior: 'allow' }), false, 'unknown prompt id → false')
assert.equal(answerPending(prompts, { db: d, schema }, (e) => events.push(e), req.promptId, { behavior: 'allow', always: true }), true)
const result = await p as any
assert.equal(result.behavior, 'allow'); assert.equal(result.updatedPermissions.length, 1)
row = d.select().from(schema.permissionRequests).where(eq(schema.permissionRequests.id, req.promptId)).get()!
assert.equal(row.status, 'allowed'); assert.equal(row.always, true); assert.ok(row.resolvedAt)
assert.equal(prompts.size, 0); assert.equal(waiting, false)
assert.ok(events.some((e) => e.t === 'permission_resolved' && (e as any).status === 'allowed'))

// AskUserQuestion kind + abort (interrupt / close) → cancelled, promise settles as deny
const p2 = bridge('AskUserQuestion', { questions: [{ question: 'Q?' }] }, { signal: ac.signal } as any)
await new Promise((r) => setTimeout(r, 5))
const req2 = events.filter((e) => e.t === 'permission_request').pop() as any
assert.equal(req2.kind, 'question')
ac.abort()
const r2 = await p2 as any
assert.equal(r2.behavior, 'deny')
row = d.select().from(schema.permissionRequests).where(eq(schema.permissionRequests.id, req2.promptId)).get()!
assert.equal(row.status, 'cancelled')
assert.equal(prompts.size, 0)
console.log('host-permissions: all ok')

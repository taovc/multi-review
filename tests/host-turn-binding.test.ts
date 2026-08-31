import assert from 'node:assert/strict'
import type { RunEvent, TurnResult } from '../core/host/types'

// A result must only close the turn it actually answers. The CLI also runs turns nobody here asked for — a background
// task queued while the session was closed wakes it up and finishes in milliseconds with an empty result — and taking
// that one as the answer used to close the reply with no text and orphan everything the real turn then produced.
process.env.HOST_ORPHAN_RESULT_MS = '60'
const { claudeHost, resultOwner } = await import('../core/host/claudeHost')

const done = (o: Partial<Extract<RunEvent, { t: 'turn_done' }>> = {}): Extract<RunEvent, { t: 'turn_done' }> =>
  ({ t: 'turn_done', subtype: 'success', isError: false, resultText: 'answer', costUsd: 1, durationMs: 1000, numTurns: 3, usage: null, ...o })

// The no-op result the CLI emits for its own wake-up turn (empty, zero model turns, names no send).
const metaResult = done({ resultText: '', numTurns: 0, costUsd: 0, durationMs: 207 })

// ── resultOwner (pure) ──
assert.equal(resultOwner(done({ userMessageUuid: 'U1' }), { uuid: 'U1', activity: true }), 'ours')
assert.equal(resultOwner(done({ userMessageUuid: 'U2' }), { uuid: 'U1', activity: true }), 'foreign', 'a result naming another send is not ours')
assert.equal(resultOwner(metaResult, { uuid: 'U1', activity: false }), 'unsure', 'an unnamed no-op result while our turn is still silent')
assert.equal(resultOwner(metaResult, { uuid: 'U1', activity: true }), 'ours', 'once our turn has produced output, a result cannot be about nothing')
assert.equal(resultOwner(done({ numTurns: 0, resultText: '', isError: true, subtype: 'error_during_execution' }), { uuid: 'U1', activity: false }), 'unsure', 'a meta turn that FAILS is no more ours than one that succeeds')
assert.equal(resultOwner(done({ isError: true, subtype: 'error_max_turns', resultText: 'out of turns' }), { uuid: 'U1', activity: false }), 'ours', 'a failure that says something did happen ends our turn')
assert.equal(resultOwner(done(), { uuid: 'U1', activity: false }), 'ours', 'an older CLI sends no uuid: a real result still ends the turn')
assert.equal(resultOwner(metaResult, { uuid: 'U1', activity: false, interrupted: true }), 'ours', 'an interrupted turn ends on the next unnamed result, empty or not')
assert.equal(resultOwner(done({ userMessageUuid: 'U-other' }), { uuid: 'U1', activity: false, interrupted: true }), 'foreign', 'but Stop never claims a result that names another send')

// ── the host wiring ──
type Live = { events: RunEvent[]; resolved: TurnResult | null } & Record<string, any>

function liveRun(): Live {
  const events: RunEvent[] = []
  return {
    events, resolved: null,
    spec: { runId: 'RT', kind: 'session', cwd: '/tmp' }, // no db/schema: the recorder and setRunStatus no-op
    q: { getContextUsage: async () => { throw new Error('unsupported') } },
    sessionId: 'S1', busy: false, turn: null, prompts: new Map(), promptTimers: new Map(),
    lastCumulative: null, idleTimer: null, orphanTimer: null, closed: false, lastUsedAt: Date.now(), init: null, stderr: '',
    emit: (e: RunEvent) => { events.push(e) },
  }
}

function startTurn(live: Live, uuid: string): void {
  live.busy = true
  live.turn = { turnId: 'T1', cb: {}, uuid, activity: false, text: '', resolve: (r: TurnResult) => { live.resolved = r }, interrupted: false }
}

const dispatch = (live: Live, e: RunEvent) => (claudeHost as any).dispatch(live, e)

// 1) The incident: the CLI's own wake-up turn ends first, then the real turn runs and answers.
{
  const live = liveRun()
  startTurn(live, 'U-ours')
  dispatch(live, { t: 'task', status: 'stopped', taskId: 'w1', summary: 'no completion record' })
  dispatch(live, metaResult)
  assert.equal(live.resolved, null, 'the wake-up result must not answer our send')
  assert.ok(live.turn, 'the turn stays open')
  assert.equal(live.busy, true)
  assert.ok(live.events.some((e) => e.t === 'note'), 'the ignored result is still logged')
  assert.equal(live.events.filter((e) => e.t === 'turn_done').length, 0, 'no turn_done is published for it')

  dispatch(live, { t: 'assistant_text', text: 'the real reply', uuid: 'a1', parent: null })
  assert.equal(live.turn.activity, true)
  assert.equal(live.turn.text, 'the real reply')
  dispatch(live, done({ userMessageUuid: 'U-ours', resultText: 'the real reply' }))
  assert.equal(live.resolved?.text, 'the real reply')
  assert.equal(live.busy, false)
  assert.equal(live.turn, null)
}

// 2) A result naming a different send never answers ours — and the real one still can, if it arrives in time.
{
  const live = liveRun()
  startTurn(live, 'U-ours')
  dispatch(live, done({ userMessageUuid: 'U-other', resultText: 'someone else' }))
  assert.equal(live.resolved, null)
  dispatch(live, done({ userMessageUuid: 'U-ours', resultText: 'ours' }))
  assert.equal(live.resolved?.text, 'ours')
  assert.equal(live.resolved?.isError, false)
  assert.equal(live.orphanTimer, null, 'finishing the turn disarms the wait')
}

// 2b) …but a session that only ever answers other sends must fail the turn, not hold it for good.
{
  const live = liveRun()
  startTurn(live, 'U-ours')
  dispatch(live, done({ userMessageUuid: 'U-other', resultText: 'someone else' }))
  assert.ok(live.orphanTimer, 'a foreign result still starts the clock: nothing else would ever end this turn')
  await new Promise((r) => setTimeout(r, 40))
  dispatch(live, done({ userMessageUuid: 'U-third', resultText: 'and another' }))
  assert.equal(live.resolved, null, 'each result we turn down re-arms the wait rather than letting a stale one fire')
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(live.resolved?.isError, true)
  assert.equal(live.resolved?.subtype, 'no_matching_result')
  assert.equal(live.busy, false)
}

// 2c) A pending fallback belongs to the turn it was armed for, never to whatever turn is live when it fires.
{
  const live = liveRun()
  startTurn(live, 'U-ours')
  dispatch(live, metaResult)
  assert.ok(live.orphanTimer, 'armed for the first turn')
  startTurn(live, 'U-next') // a second send replaces the turn without going through finishTurn
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(live.resolved, null, 'the first turn\'s fallback leaves the second turn alone')
  assert.equal(live.busy, true)
}

// 3) Back-compat: an older CLI echoes no uuid at all, so its results must still close the turn.
{
  const live = liveRun()
  startTurn(live, 'U-ours')
  dispatch(live, done({ resultText: 'legacy reply' }))
  assert.equal(live.resolved?.text, 'legacy reply')
}

// 4) …and if such a CLI ends a turn with nothing at all, the fallback closes it instead of hanging forever.
{
  const live = liveRun()
  startTurn(live, 'U-ours')
  dispatch(live, metaResult)
  assert.equal(live.resolved, null)
  assert.ok(live.orphanTimer, 'the fallback is armed')
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(live.resolved?.subtype, 'success', 'the unattributable result is accepted once the session goes quiet')
  assert.equal(live.busy, false)
}

// 5) Stop must not wait on the fallback: an interrupted turn ends on whatever unnamed result comes back.
{
  const live = liveRun()
  startTurn(live, 'U-ours')
  live.turn.interrupted = true
  dispatch(live, metaResult)
  assert.equal(live.resolved?.interrupted, true)
  assert.equal(live.orphanTimer, null)
}

// 5b) A worktree session's /clear answers with a reset and an empty result: that must not stall the composer.
{
  const live = liveRun()
  startTurn(live, 'U-ours')
  dispatch(live, { t: 'reset', sessionId: 'S2' })
  dispatch(live, metaResult)
  assert.equal(live.resolved?.subtype, 'success', 'the reset proves the CLI acted on our message')
  assert.equal(live.orphanTimer, null)
}

// 6) Real output cancels the fallback: subagent chatter does not, main-thread output does.
{
  const live = liveRun()
  startTurn(live, 'U-ours')
  dispatch(live, metaResult)
  dispatch(live, { t: 'assistant_text', text: 'from a subagent', uuid: 'a2', parent: 'toolu_1' })
  assert.ok(live.orphanTimer, 'subagent output says nothing about the main turn')
  assert.equal(live.turn.activity, false)
  dispatch(live, { t: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' }, parent: null })
  assert.equal(live.orphanTimer, null, 'main-thread output cancels the fallback')
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(live.resolved, null, 'and the turn is still ours to finish')
}

// 7) A foreign turn's spend stays on the baseline so it rolls into the next real result instead of vanishing.
{
  const live = liveRun()
  startTurn(live, 'U-ours')
  const usage = (cost: number, input: number) => ({ models: [{ model: 'm', inputTokens: input, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, costUsd: cost, costSource: 'reported' as const }], costUsd: cost, costSource: 'reported' as const, numTurns: 1, durationMs: 1 })
  live.lastCumulative = usage(1, 100)
  dispatch(live, done({ userMessageUuid: 'U-other', resultText: 'x', usage: usage(3, 300) }))
  assert.deepEqual(live.lastCumulative, usage(1, 100), 'the baseline is untouched by a foreign result')
  dispatch(live, done({ userMessageUuid: 'U-ours', resultText: 'y', usage: usage(4, 400) }))
  assert.equal(live.resolved?.costUsd, 3, 'our turn is billed for everything since the last turn of ours')
}

console.log('✓ host-turn-binding')

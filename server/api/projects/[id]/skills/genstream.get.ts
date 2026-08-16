import { cockpitBus } from '~core/events'

// SSE: skill generation progress (which file the agent is reading / what it greps / done). key = skillgen:<projectId>
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  setResponseHeaders(event, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  const res = event.node.res
  res.write(': ok\n\n')

  let closed = false
  const unsub = cockpitBus.subscribe(`skillgen:${id}`, (e) => {
    if (!closed) res.write(`data: ${JSON.stringify(e)}\n\n`)
  })
  const heartbeat = setInterval(() => {
    if (!closed) res.write(': ping\n\n')
  }, 15_000)
  heartbeat.unref?.()

  event.node.req.on('close', () => {
    closed = true
    clearInterval(heartbeat)
    unsub()
  })
  return new Promise<void>((resolve) => event.node.req.on('close', resolve))
})

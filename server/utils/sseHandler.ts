import { cockpitBus } from '~core/events'

// SSE endpoint factory: the 4 stream endpoints (review/fix/global/feature) are word-for-word identical except for how the channel key is derived from :id.
// Pass channelKeyFn to reuse one transport implementation (headers / handshake / JSON push / 15s heartbeat / close cleanup).
// Note: the channel key must match what each pipeline emits with — fix/review use the bare id, global = g:<id>, feature = f:<id>; get it wrong and events are pushed to the wrong drawer.
export function createSseHandler(channelKeyFn: (id: string) => string) {
  return defineEventHandler(async (event) => {
    const id = getRouterParam(event, 'id')!
    setResponseHeaders(event, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    const res = event.node.res
    const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`)
    res.write(': ok\n\n')

    let closed = false
    const unsub = cockpitBus.subscribe(channelKeyFn(id), (e) => {
      if (!closed) send(e)
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
}

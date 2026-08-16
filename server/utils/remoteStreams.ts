// Only res.end() and req's close event are used, so no h3 types here (it's a transitive dependency and can't be imported directly).
type StreamEvent = {
  node: {
    res: { end: () => void }
    req: { on: (event: 'close', cb: () => void) => void }
  }
}

// Tracks authenticated "remote" (non-loopback) long-lived connections. Disconnect all of them when
// remote access is turned off / the token is rotated, otherwise an already-connected EventSource (SSE)
// would keep receiving live agent/chat/review data after the device has been revoked.
// Only remote connections are registered: the Electron window's own (loopback) streams never land
// here, so they can't be killed by mistake.
const streams = new Set<StreamEvent['node']['res']>()

export function trackRemoteStream(event: StreamEvent): void {
  const res = event.node.res
  streams.add(res)
  event.node.req.on('close', () => streams.delete(res))
}

export function closeRemoteStreams(): void {
  for (const res of [...streams]) {
    try {
      res.end()
    } catch {
      /* already closed */
    }
    streams.delete(res)
  }
}

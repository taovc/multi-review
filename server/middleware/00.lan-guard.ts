import { networkInterfaces } from 'node:os'
import { getLanState, isValidToken, isLoopbackAddress, LAN_COOKIE, LAN_TOKEN_PARAM } from '../utils/lanState'
import { trackRemoteStream } from '../utils/remoteStreams'

// "Bind wide, authenticate per request": Nitro listens on 0.0.0.0, but this gate decides who can
// actually use it.
// - The local machine (Electron window / internal SSR requests) is always allowed.
// - Remote devices: always 403 while remote access is off; when on, a valid token is required (once
//   in the URL, then via cookie).
// The 00. filename prefix makes it run before every other middleware.

const COOKIE_MAX_AGE = 60 * 60 * 24 * 30 // 30 days

// One generic 403 everywhere, so different wording can't fingerprint the system for an attacker.
function forbidden(): never {
  throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
}

// Host allowlist (port excluded): loopback + every LAN IPv4 of this machine. Prevents DNS rebinding —
// an attacker rebinds evil.com with a short TTL to 127.0.0.1, so the peer looks like loopback but the
// Host header is still evil.com → reject.
function allowedHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return true // no Host (in-process request) → allow
  const host = hostHeader
    .split(':')[0]
    .toLowerCase()
    .replace(/^\[|\]$/g, '') // strip the brackets of an IPv6 literal
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal && ni.address === host) return true
    }
  }
  return false
}

export default defineEventHandler((event) => {
  // Host allowlist first: check the Host even when the peer is loopback (rebinding disguises itself
  // as loopback).
  if (!allowedHost(getRequestHeader(event, 'host'))) forbidden()

  const remote = event.node.req.socket?.remoteAddress
  // Local machine (including address-less internal SSR requests; the top-level document request has
  // already passed the gate) → allow.
  if (isLoopbackAddress(remote)) return

  const state = getLanState()
  if (!state.enabled) forbidden()

  // Already-authenticated device: a valid cookie passes straight through, and its long-lived
  // connections are registered (so they can be dropped when access is turned off / the token is
  // rotated).
  if (isValidToken(getCookie(event, LAN_COOKIE))) {
    trackRemoteStream(event)
    return
  }

  // First entry through a token-bearing link/QR → validate it and exchange it for an httpOnly cookie.
  const q = getQuery(event)
  const qtoken = typeof q[LAN_TOKEN_PARAM] === 'string' ? (q[LAN_TOKEN_PARAM] as string) : undefined
  if (isValidToken(qtoken)) {
    setCookie(event, LAN_COOKIE, qtoken!, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: COOKIE_MAX_AGE,
    })
    setResponseHeader(event, 'Referrer-Policy', 'no-referrer')
    // Document GET: 302 to strip the token from the URL (the cookie is already set), keeping it out
    // of the address bar / history / logs.
    if (event.method === 'GET') {
      const url = getRequestURL(event)
      url.searchParams.delete(LAN_TOKEN_PARAM)
      return sendRedirect(event, url.pathname + url.search, 302)
    }
    trackRemoteStream(event)
    return
  }

  forbidden()
})

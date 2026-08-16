import { z } from 'zod'
import { setLanEnabled, rotateLanToken, lanInfo, isLoopbackAddress } from '../../utils/lanState'
import { closeRemoteStreams } from '../../utils/remoteStreams'

// Toggle remote access / revoke the old link. Only the local machine (the Electron window) calls it.
// Layered hardening:
// (1) loopback peers only; (2) Sec-Fetch-Site must be same-origin/none (blocks cross-site);
// (3) require application/json (the CORS safelisted multipart/text can be sent cross-site without a
// preflight, JSON triggers one and gets blocked).
// Together they shut out CSRF: a malicious page in an ordinary browser cannot satisfy all three when
// forging a request to http://127.0.0.1.
const Body = z.object({
  enabled: z.boolean().optional(),
  rotate: z.boolean().optional(),
})

export default defineEventHandler(async (event) => {
  if (!isLoopbackAddress(event.node.req.socket?.remoteAddress)) forbidden()

  const sfs = getRequestHeader(event, 'sec-fetch-site')
  if (sfs && sfs !== 'same-origin' && sfs !== 'none') forbidden()

  const ct = (getRequestHeader(event, 'content-type') || '').toLowerCase()
  if (!ct.includes('application/json')) {
    throw createError({ statusCode: 415, statusMessage: 'Content-Type must be application/json' })
  }

  const parsed = Body.safeParse(await readBody(event))
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: parsed.error.issues.map((i) => i.message).join('; ') })
  }
  const { enabled, rotate } = parsed.data
  if (rotate) rotateLanToken()
  if (typeof enabled === 'boolean') setLanEnabled(enabled)
  // Revoking (turning off / rotating the token) → drop the already-connected remote streams immediately,
  // so a revoked device stops receiving data.
  if (rotate || enabled === false) closeRemoteStreams()

  const port = event.node.req.socket?.localPort ?? 3000
  return await lanInfo(port, true) // local caller, return the full info
})

function forbidden(): never {
  throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
}

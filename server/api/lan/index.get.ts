import { lanInfo, isLoopbackAddress } from '../../utils/lanState'

// Current LAN remote-access state + addresses/share link/QR. The port is derived from the current connection,
// so both dev (3000) and the packaged app (random port) adapt on their own.
// Only the local machine (the Electron window) gets the token/QR/LAN addresses; authorized remote devices only get enabled back.
export default defineEventHandler(async (event) => {
  const port = event.node.req.socket?.localPort ?? 3000
  const loopback = isLoopbackAddress(event.node.req.socket?.remoteAddress)
  return await lanInfo(port, loopback)
})

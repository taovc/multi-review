import { nanoid } from 'nanoid'
import { timingSafeEqual } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import QRCode from 'qrcode'

// Runtime state of LAN remote access. Off by default — only when the user turns it on
// in the app are non-loopback devices (iPad/phone) allowed in, and they must carry the one-off generated token.
// The state is persisted to lan.json next to the DB, so the user's choice survives a restart.
export type LanState = { enabled: boolean; token: string }

// Name of the query parameter carrying the token / of the auth cookie. The QR code encodes ?mr_token=<token>,
// which is swapped for a cookie on first open; every later JS/CSS/API/SSE request is let through by the cookie.
export const LAN_TOKEN_PARAM = 'mr_token'
export const LAN_COOKIE = 'mr_lan'

let state: LanState | null = null

function statePath(): string {
  const cfg = useRuntimeConfig()
  return join(dirname(cfg.dbPath as string), 'lan.json')
}

function load(): LanState {
  if (state) return state
  try {
    const parsed = JSON.parse(readFileSync(statePath(), 'utf8'))
    const token = typeof parsed.token === 'string' && parsed.token ? parsed.token : nanoid()
    state = { enabled: !!parsed.enabled, token }
  } catch {
    // File missing/corrupt: start from the off state with a token ready ahead of time (reused as-is when enabled)
    state = { enabled: false, token: nanoid() }
  }
  return state
}

function persist() {
  try {
    const p = statePath()
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify(state), 'utf8')
  } catch {
    /* best-effort persistence; failing to write doesn't affect the current in-memory state */
  }
}

export function getLanState(): LanState {
  return { ...load() }
}

// Turn remote access on/off. Off = revoke: swap in a new token so already-handed-out cookies/links die immediately —
// and turning it back on does not resurrect the old credential (otherwise "off" would only be a pause and a de-authed device's 30-day cookie would come back).
// On: keep the existing token (create one if missing).
export function setLanEnabled(enabled: boolean): LanState {
  const s = load()
  state = { enabled, token: enabled ? s.token || nanoid() : nanoid() }
  persist()
  return { ...state }
}

// Invalidate old links: swap in a new token, so already-handed-out QR codes/links stop working right away.
export function rotateLanToken(): LanState {
  load()
  state = { enabled: state!.enabled, token: nanoid() }
  persist()
  return { ...state }
}

// Whether the request comes from this machine. A missing address = in-process SSR rendering, also treated as local.
export function isLoopbackAddress(addr: string | undefined | null): boolean {
  if (!addr) return true
  return addr === '::1' || addr === '::ffff:127.0.0.1' || addr.startsWith('127.')
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

// Whether a token is valid: remote access must be enabled and the token byte-for-byte equal to the current one.
export function isValidToken(token: string | undefined | null): boolean {
  if (!token) return false
  const s = load()
  return s.enabled && safeEqual(token, s.token)
}

export type Ipv4Iface = { name: string; address: string }

// With several NICs (Wi-Fi + VPN + Docker bridge…) networkInterfaces() does not guarantee an order, so taking the first one
// can hand out an address the phone can't reach at all (VPN/virtual subnet). Score every interface and put the most likely reachable first:
// physical NICs (en/eth/wlan) first, common home/office private ranges (192.168 / 10 / 172.16-31) first,
// virtual/VPN interface names and link-local (169.254) demoted. Pure function, easy to unit test.
export function rankIpv4(ifaces: Ipv4Iface[]): string[] {
  const score = ({ name, address }: Ipv4Iface): number => {
    let s = 0
    const n = name.toLowerCase()
    // Check virtual/VPN/container first (a name can look physical at the same time, e.g. Windows' "vEthernet").
    const virtual =
      /^(utun|tun|tap|ppp|wg|awdl|llw|bridge|docker|br-|veth|vmnet|vboxnet|virbr|vnic|zt|ham|tailscale|wsl)/.test(n) ||
      /virtualbox|vmware|hyper-?v|vethernet|loopback/.test(n)
    // Physical NICs: macOS enX, Linux ethX/eno1/ens160/enp*/enx*/wlan*/wlp*, Windows "Ethernet"/"Wi-Fi".
    // (No longer requires a digit right after the prefix, which used to miss systemd names like eno1/ens160 and Windows friendly names.)
    const physical = /^(en|eth|wl)/.test(n) || /ethernet|wi[-_ ]?fi/.test(n)
    if (virtual) s -= 100
    else if (physical) s += 100

    if (address.startsWith('169.254.')) s -= 1000 // link-local: basically unreachable
    else if (/^192\.168\.(56|122)\./.test(address)) s -= 200 // VirtualBox host-only / libvirt default range
    else if (address.startsWith('172.17.')) s -= 60 // Docker default bridge
    else if (address.startsWith('192.168.')) s += 50
    else if (address.startsWith('10.')) s += 40
    else if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) s += 20 // private, but often taken by containers → weak preference
    else s += 10 // anything else (public ranges etc.) — rare on a LAN
    return s
  }
  // Stable sort: score descending, ties keep the original networkInterfaces() order
  return ifaces
    .map((f, i) => ({ f, i, s: score(f) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map(({ f }) => f.address)
}

// All non-loopback IPv4 addresses of this machine, sorted by reachability (the first is the one a phone is most likely to reach).
function lanUrls(port: number): string[] {
  const ifaces: Ipv4Iface[] = []
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) ifaces.push({ name, address: ni.address })
    }
  }
  return rankIpv4(ifaces).map((addr) => `http://${addr}:${port}`)
}

// The full payload for the UI: address list + share link carrying the token + QR data URL.
// port is derived by the caller from the current connection (dev and packaged ports differ).
// loopback=false (remote caller): only enabled is returned, never the token/QR/LAN addresses — otherwise an already
// authorized remote script could fetch the token in plaintext (defeating httpOnly) or probe this machine's LAN IP+port (DNS-rebinding exploit).
export async function lanInfo(port: number, loopback: boolean) {
  const s = load()
  if (!loopback) return { enabled: s.enabled, urls: [] as string[], link: null, qr: null }
  const urls = lanUrls(port)
  let link: string | null = null
  let qr: string | null = null
  if (s.enabled && urls.length) {
    link = `${urls[0]}/?${LAN_TOKEN_PARAM}=${s.token}`
    qr = await QRCode.toDataURL(link, { margin: 1, width: 240 })
  }
  return { enabled: s.enabled, urls, link, qr }
}

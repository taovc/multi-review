import assert from 'node:assert/strict'
import { rankIpv4 } from '../server/utils/lanState'

// With several NICs, put the LAN address most likely to be reachable first (used by the QR/share link).

// 1) Wi-Fi + VPN(utun) + Docker bridge: should pick the physical en0's 192.168 address
assert.equal(
  rankIpv4([
    { name: 'utun3', address: '10.2.0.5' }, // VPN
    { name: 'en0', address: '192.168.1.44' }, // Wi-Fi
    { name: 'bridge100', address: '172.17.0.1' }, // Docker bridge
  ])[0],
  '192.168.1.44',
)

// 2) Physical NIC on 10.x (some office networks), VPN on 10.x too: the physical NIC wins over the VPN
assert.equal(
  rankIpv4([
    { name: 'utun0', address: '10.8.0.2' }, // VPN
    { name: 'en1', address: '10.0.0.23' }, // physical
  ])[0],
  '10.0.0.23',
)

// 3) link-local(169.254) always comes last
{
  const r = rankIpv4([
    { name: 'en5', address: '169.254.10.10' },
    { name: 'en0', address: '192.168.0.7' },
  ])
  assert.equal(r[0], '192.168.0.7')
  assert.equal(r[r.length - 1], '169.254.10.10')
}

// 4) Single NIC: returned as-is
assert.deepEqual(rankIpv4([{ name: 'en0', address: '192.168.1.2' }]), ['192.168.1.2'])

// 5) Empty input: empty array
assert.deepEqual(rankIpv4([]), [])

// 6) A systemd name (eno1) must rank before the libvirt bridge (virbr0) — the earlier regex missed eno1
assert.equal(
  rankIpv4([
    { name: 'virbr0', address: '192.168.122.1' }, // libvirt default bridge
    { name: 'eno1', address: '10.0.0.50' }, // physical NIC (systemd naming)
  ])[0],
  '10.0.0.50',
)

// 7) Windows friendly names: a real "Wi-Fi" ranks before the VirtualBox host-only adapter
assert.equal(
  rankIpv4([
    { name: 'VirtualBox Host-Only Ethernet Adapter', address: '192.168.56.1' },
    { name: 'Wi-Fi', address: '192.168.1.20' },
  ])[0],
  '192.168.1.20',
)

// 8) The Docker default bridge (172.17) ranks after a real NIC
assert.equal(
  rankIpv4([
    { name: 'docker0', address: '172.17.0.1' },
    { name: 'ens160', address: '10.1.2.3' },
  ])[0],
  '10.1.2.3',
)

console.log('lan-rank-ipv4: ok')

import assert from 'node:assert/strict'
import { computeUpdate, pickAsset, parseRemoteSha } from '../electron/updateLogic.mjs'

const release = {
  body: 'Rolling build from the latest `main` (e69f14c). Overwritten on every merge.',
  assets: [
    { name: 'latest-mac.yml', updated_at: '2026-07-01T12:46:20Z', browser_download_url: 'x' },
    { name: 'pr-cockpit-0.1.0-arm64.dmg', updated_at: '2026-07-01T12:46:31Z', browser_download_url: 'dmg-arm64' },
    { name: 'pr-cockpit-0.1.0-x64.exe', updated_at: '2026-07-01T12:46:28Z', browser_download_url: 'exe' },
    { name: 'pr-cockpit-0.1.0-x86_64.AppImage', updated_at: '2026-07-01T12:46:35Z', browser_download_url: 'appimage' },
  ],
}

// parseRemoteSha
assert.equal(parseRemoteSha(release.body), 'e69f14c')
assert.equal(parseRemoteSha('no sha here'), null)

// pickAsset: mac arm64 → the arm64 dmg; win x64 → exe; linux → AppImage
assert.equal(pickAsset(release.assets, 'darwin', 'arm64')?.browser_download_url, 'dmg-arm64')
assert.equal(pickAsset(release.assets, 'win32', 'x64')?.browser_download_url, 'exe')
assert.equal(pickAsset(release.assets, 'linux', 'x64')?.browser_download_url, 'appimage')

// arch synonyms: x64 must match an x86_64-named asset, and NOT grab the arm64 one
// when both exist (electron-builder names AppImages x86_64 / aarch64).
const dualArch = {
  body: '(deadbee)',
  assets: [
    { name: 'pr-cockpit-0.1.0-aarch64.AppImage', browser_download_url: 'appimage-arm64' },
    { name: 'pr-cockpit-0.1.0-x86_64.AppImage', browser_download_url: 'appimage-x64' },
  ],
}
assert.equal(pickAsset(dualArch.assets, 'linux', 'x64')?.browser_download_url, 'appimage-x64')
assert.equal(pickAsset(dualArch.assets, 'linux', 'arm64')?.browser_download_url, 'appimage-arm64')

// 1) same sha → never an update, even if the asset timestamp is later
assert.equal(
  computeUpdate({ sha: 'e69f14c1111111111111111111111111111111', time: '2026-07-01T00:00:00Z' }, release, 'darwin', 'arm64').update,
  false,
)

// 2) different sha + asset newer than our build → update
assert.equal(
  computeUpdate({ sha: 'aaaaaaa0000000000000000000000000000000', time: '2026-07-01T10:00:00Z' }, release, 'darwin', 'arm64').update,
  true,
)

// 3) different sha but we built AFTER the nightly (local ahead) → no update
assert.equal(
  computeUpdate({ sha: 'bbbbbbb0000000000000000000000000000000', time: '2026-07-01T20:00:00Z' }, release, 'darwin', 'arm64').update,
  false,
)

// 4) no matching asset for the platform → not an update
assert.equal(
  computeUpdate({ sha: 'ccccccc', time: '2026-07-01T10:00:00Z' }, { body: '(deadbee)', assets: [] }, 'darwin', 'arm64').update,
  false,
)

console.log('update-logic: ok')

// Pure logic: decide from a nightly release whether "a newer build exists". Extracted so it doesn't depend on electron and can be unit tested.

// The installer asset for the current platform. mac=.dmg / win=.exe / linux=.AppImage, preferring a CPU-architecture match.
// Architecture names are spelled several ways: x64 installers are often called x86_64 (electron-builder's AppImage), and arm64 is also aarch64;
// match on synonym groups to avoid mismatches like "an x64 user offered an arm64 package".
export function pickAsset(assets, platform = process.platform, arch = process.arch) {
  const ext = platform === 'darwin' ? '.dmg' : platform === 'win32' ? '.exe' : '.appimage'
  const synonyms = arch === 'arm64' ? ['arm64', 'aarch64'] : arch === 'x64' ? ['x64', 'x86_64', 'amd64'] : [arch]
  const byExt = (assets || []).filter((a) => (a.name || '').toLowerCase().endsWith(ext))
  return byExt.find((a) => synonyms.some((tok) => (a.name || '').toLowerCase().includes(tok))) || byExt[0] || null
}

// Parse the short sha out of the release notes: "Rolling build ... (abc1234)".
export function parseRemoteSha(body) {
  const m = (body || '').match(/\(([0-9a-f]{7,40})\)/i)
  return m ? m[1].toLowerCase() : null
}

// Whether a newer build exists: the sha differs AND the asset's update time is later than the local build time.
// Same sha → never prompt (avoids a false positive from a seconds-level time difference when you're already running that nightly).
export function computeUpdate(build, release, platform = process.platform, arch = process.arch) {
  const asset = pickAsset(release.assets, platform, arch)
  const remoteSha = parseRemoteSha(release.body)
  const ourSha = build.sha ? build.sha.toLowerCase() : null
  if (remoteSha && ourSha && ourSha.startsWith(remoteSha)) return { asset, update: false, remoteSha }

  const assetTime = asset ? Date.parse(asset.updated_at) : NaN
  const ourTime = Date.parse(build.time)
  const newer = Number.isFinite(assetTime) && Number.isFinite(ourTime) && assetTime > ourTime
  return { asset, update: newer, remoteSha }
}

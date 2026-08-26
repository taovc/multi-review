#!/usr/bin/env node
// nuxt build copies better-sqlite3's prebuilt binary for the *system node* ABI into .output.
// Electron runs Nitro on its own bundled node (different ABI, electron 35 = ABI 133), so loading that
// binary directly crashes on a NODE_MODULE_VERSION mismatch. This uses the prebuild-install that ships
// with better-sqlite3 to download the prebuilt binary for the matching Electron version and overwrite
// the one in .output.
// From better-sqlite3 v13 on this is no longer needed: it ships Node-API binaries under prebuilds/
// (<platform>-<arch>.node), which are ABI-stable across node and electron, so we bail out early there.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const root = process.cwd()

function log(msg) {
  process.stdout.write(`[prepare-electron-sqlite] ${msg}\n`)
}

const outputBs3 = path.join(root, '.output', 'server', 'node_modules', 'better-sqlite3')

// better-sqlite3 >= 13: Node-API prebuild, same binary for node and electron — nothing to patch.
const napiTarget = `${process.platform}-${process.arch}.node`
const napiBinary = path.join(outputBs3, 'prebuilds', napiTarget)
if (fs.existsSync(napiBinary)) {
  log(`Node-API prebuild present (prebuilds/${napiTarget}); electron loads it as-is, skipping ABI patch.`)
  process.exit(0)
}

const outputBinary = path.join(outputBs3, 'build', 'Release', 'better_sqlite3.node')
if (!fs.existsSync(outputBinary)) {
  log(`No better-sqlite3 binary in .output (${outputBinary}). Run \`nuxt build\` first.`)
  process.exit(1)
}

// Electron version → prebuild-install maps it to the right ABI
const electronVersion = require('electron/package.json').version
const bs3Dir = path.dirname(require.resolve('better-sqlite3/package.json'))
// Resolve prebuild-install's JS entry directly (the one under .bin is a shell wrapper, which node can't parse)
const bs3Require = createRequire(path.join(bs3Dir, 'package.json'))
let prebuildBin
try {
  const pkgJson = bs3Require.resolve('prebuild-install/package.json')
  const binField = require(pkgJson).bin
  const binRel = typeof binField === 'string' ? binField : binField['prebuild-install']
  prebuildBin = path.join(path.dirname(pkgJson), binRel)
} catch {
  prebuildBin = ''
}
if (!prebuildBin || !fs.existsSync(prebuildBin)) {
  log(`prebuild-install entry not found (resolved: ${prebuildBin || 'none'})`)
  process.exit(1)
}

// Download into an isolated directory so the root node_modules binary stays untouched (dev keeps using the system node ABI)
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-bs3-electron-'))
fs.cpSync(path.join(bs3Dir, 'package.json'), path.join(tmpDir, 'package.json'))

log(`Fetching better-sqlite3 prebuilt for Electron ${electronVersion} (${process.platform}-${process.arch})…`)
const res = spawnSync(
  process.execPath,
  [
    prebuildBin,
    '--runtime', 'electron',
    '--target', electronVersion,
    '--arch', process.arch,
    '--platform', process.platform,
  ],
  { cwd: tmpDir, stdio: 'inherit' }
)

if (res.status !== 0) {
  log('prebuild-install failed. Ensure network access to the better-sqlite3 GitHub releases.')
  fs.rmSync(tmpDir, { recursive: true, force: true })
  process.exit(res.status ?? 1)
}

const fetched = path.join(tmpDir, 'build', 'Release', 'better_sqlite3.node')
if (!fs.existsSync(fetched)) {
  log(`Expected binary not produced at ${fetched}`)
  fs.rmSync(tmpDir, { recursive: true, force: true })
  process.exit(1)
}

fs.copyFileSync(fetched, outputBinary)
fs.rmSync(tmpDir, { recursive: true, force: true })
log(`Patched ${path.relative(root, outputBinary)} with Electron-ABI binary.`)

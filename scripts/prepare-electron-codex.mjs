#!/usr/bin/env node
// Copy the vendored Codex CLI binaries into .output/vendor/codex/bin so the packaged app runs the exact version the
// dev build was tested with (core/codex/bin.ts looks there first). Without this the packaged app would fall back to
// whatever `codex` is on the user's PATH — possibly an older line that fights the vendored one over
// ~/.codex/thread_history_1.sqlite. Signing note: electron-builder signs extraResources binaries on macOS only when
// listed under `binaries` or with --deep; verify notarization before shipping.
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const log = (msg) => process.stdout.write(`[prepare-electron-codex] ${msg}\n`)

const TRIPLES = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'win32-x64': 'x86_64-pc-windows-msvc',
}
const key = `${process.platform}-${process.arch}`
const triple = TRIPLES[key]
if (!triple) { log(`unsupported platform ${key}`); process.exit(1) }

function findVendorBin() {
  const candidates = []
  const pnpmDir = path.join(root, 'node_modules', '.pnpm')
  try {
    for (const entry of fs.readdirSync(pnpmDir).filter((e) => e.startsWith('@openai+codex@') && e.endsWith(`-${key}`)).sort().reverse()) {
      candidates.push(path.join(pnpmDir, entry, 'node_modules', '@openai', 'codex', 'vendor', triple, 'bin'))
    }
  } catch { /* not pnpm */ }
  candidates.push(path.join(root, 'node_modules', '@openai', `codex-${key}`, 'vendor', triple, 'bin'))
  candidates.push(path.join(root, 'node_modules', '@openai', 'codex', 'vendor', triple, 'bin'))
  return candidates.find((d) => fs.existsSync(path.join(d, process.platform === 'win32' ? 'codex.exe' : 'codex')))
}

const src = findVendorBin()
if (!src) { log('vendored codex binary not found in node_modules (is @openai/codex installed?)'); process.exit(1) }
const dest = path.join(root, '.output', 'vendor', 'codex', 'bin')
fs.mkdirSync(dest, { recursive: true })
let copied = 0
for (const name of fs.readdirSync(src)) {
  const from = path.join(src, name)
  if (!fs.statSync(from).isFile()) continue
  fs.copyFileSync(from, path.join(dest, name))
  fs.chmodSync(path.join(dest, name), 0o755)
  copied++
}
log(`copied ${copied} file(s) from ${path.relative(root, src)} → ${path.relative(root, dest)}`)

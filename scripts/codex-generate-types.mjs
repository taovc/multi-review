#!/usr/bin/env node
// Regenerate the app-server protocol bindings from the vendored codex binary into core/codex/protocol (committed, so
// the types always match the pinned @openai/codex version). Run after bumping @openai/codex: `pnpm codex:types`.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const root = process.cwd()
const require = createRequire(import.meta.url)
const pkg = require(path.join(root, 'package.json'))
const pinned = String(pkg.dependencies?.['@openai/codex'] ?? '').replace(/^[^\d]*/, '')
const TRIPLES = { 'darwin-arm64': 'aarch64-apple-darwin', 'darwin-x64': 'x86_64-apple-darwin', 'linux-arm64': 'aarch64-unknown-linux-musl', 'linux-x64': 'x86_64-unknown-linux-musl', 'win32-arm64': 'aarch64-pc-windows-msvc', 'win32-x64': 'x86_64-pc-windows-msvc' }
const key = `${process.platform}-${process.arch}`
const triple = TRIPLES[key]
const binName = process.platform === 'win32' ? 'codex.exe' : 'codex'
const candidates = []
try {
  for (const e of fs.readdirSync(path.join(root, 'node_modules', '.pnpm')).filter((e) => e.startsWith('@openai+codex@') && e.endsWith(`-${key}`)).sort().reverse()) {
    candidates.push(path.join(root, 'node_modules', '.pnpm', e, 'node_modules', '@openai', 'codex', 'vendor', triple, 'bin', binName))
  }
} catch { /* not pnpm */ }
candidates.push(path.join(root, 'node_modules', '@openai', 'codex', 'vendor', triple, 'bin', binName))
const bin = process.env.CODEX_EXECUTABLE || candidates.find((c) => fs.existsSync(c))
if (!bin) { console.error('vendored codex binary not found'); process.exit(1) }

const out = path.join(root, 'core', 'codex', 'protocol')
const tmp = fs.mkdtempSync(path.join(root, 'node_modules', '.cache', 'codex-types-'))
const r = spawnSync(bin, ['app-server', 'generate-ts', '--out', tmp], { stdio: 'inherit' })
if (r.status !== 0) { console.error('generate-ts failed'); process.exit(r.status ?? 1) }
// The whole tree: the v2 files we speak import shared primitives from the top level (ReasoningEffort, serde_json/JsonValue…).
fs.rmSync(out, { recursive: true, force: true })
fs.cpSync(tmp, out, { recursive: true })
fs.rmSync(tmp, { recursive: true, force: true })
const version = spawnSync(bin, ['--version'], { encoding: 'utf8' }).stdout.trim()
fs.writeFileSync(path.join(out, 'VERSION'), `${version}\npinned @openai/codex ${pinned}\n`)
const n = fs.readdirSync(path.join(out, 'v2')).length
console.log(`[codex-types] ${n} v2 files (+ shared primitives) → core/codex/protocol (${version})`)

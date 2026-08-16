#!/usr/bin/env node
// At package time, write "the identity of this build" into electron/build-info.json for the auto-updater to compare against.
// The nightly version number is always 0.1.0, so semver can't tell new from old → use commit sha + build time.
// CI uses GITHUB_SHA; locally `git rev-parse HEAD`. electron-builder's files includes
// electron/**/* → this file ends up in the asar and the main process reads it at runtime.
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function gitSha() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

const info = {
  sha: gitSha(),
  time: new Date().toISOString(), // a plain node script may use Date; written once, only at build time
  version: process.env.npm_package_version || '',
}

const out = path.join(__dirname, '..', 'electron', 'build-info.json')
fs.writeFileSync(out, JSON.stringify(info, null, 2) + '\n')
process.stdout.write(`[write-build-info] ${info.sha.slice(0, 7) || '(no sha)'} @ ${info.time}\n`)

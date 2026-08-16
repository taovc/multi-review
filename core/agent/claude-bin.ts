import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// Find a usable claude executable to hand to the SDK's pathToClaudeCodeExecutable.
//
// Why this is needed: the SDK ships the platform-specific native binary in an optional
// dependency (@anthropic-ai/claude-agent-sdk-<platform>-<arch>, ~200MB). In dev we run under
// the project's node_modules, so the SDK finds it on its own; but when nitro builds the
// production bundle it only traces the SDK's JS into .output, without bundling that binary —
// so the production process reports "Native CLI binary for darwin-arm64 not found". Pointing
// explicitly at an executable that definitely exists is stable in both dev and production.
//
// Resolution order:
//   ① env var escape hatch (manual override)
//   ② the same-version binary shipped with the SDK (resolvable from dev's module context)
//   ③ the claude CLI the user is already logged into, from PATH / common install dirs (production fallback)

let cached: string | null | undefined

function fromEnv(): string | undefined {
  const p = process.env.CLAUDE_CODE_EXECUTABLE || process.env.CLAUDE_CLI_PATH
  return p && existsSync(p) ? p : undefined
}

function fromSdk(): string | undefined {
  try {
    const req = createRequire(import.meta.url)
    const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`
    const pkgJson = req.resolve(`${pkg}/package.json`)
    const bin = path.join(path.dirname(pkgJson), 'claude')
    return existsSync(bin) ? bin : undefined
  } catch {
    return undefined
  }
}

function fromPath(): string | undefined {
  const dirs = (process.env.PATH || '').split(path.delimiter)
  // the production process's PATH may be incomplete, so add the common install dirs
  dirs.push(path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin')
  for (const d of dirs) {
    if (!d) continue
    const p = path.join(d, 'claude')
    if (existsSync(p)) return p
  }
  return undefined
}

export function resolveClaudeExecutable(): string | undefined {
  if (cached !== undefined) return cached ?? undefined
  const found = fromEnv() ?? fromSdk() ?? fromPath()
  cached = found ?? null
  return found
}

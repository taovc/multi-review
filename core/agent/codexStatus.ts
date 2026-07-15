import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { dirname, join, parse } from 'node:path'
import { resolveCodexExecutable } from './codexAgent'

export type CodexAuthStatus = 'authenticated' | 'missing' | 'unknown'

export type CodexSdkStatus = {
  installed: boolean
  authStatus: CodexAuthStatus
  detail: string
  sdkVersion?: string
  cliVersion?: string
}

let _cache: { value: CodexSdkStatus; at: number } | null = null
const TTL = 60_000

export async function getCodexSdkStatus(force = false): Promise<CodexSdkStatus> {
  if (!force && _cache && Date.now() - _cache.at < TTL) return _cache.value

  const value = await resolveCodexSdkStatus()
  _cache = { value, at: Date.now() }
  return value
}

async function resolveCodexSdkStatus(): Promise<CodexSdkStatus> {
  const sdkVersion = await resolveCodexSdkVersion()
  // installed = 平台 CLI 二进制能解析到（用与运行时一致的解析逻辑，nitro 打包后也准）。
  const executablePath = resolveCodexExecutable()

  if (!executablePath) {
    return {
      installed: false,
      authStatus: 'unknown',
      sdkVersion,
      detail: '找不到 Codex CLI 二进制。请确认 `pnpm install` 装上了 @openai/codex 的平台包，或设置 CODEX_EXECUTABLE 指向 codex 可执行文件。',
    }
  }
  const cliVersion = await runCodexVersion(executablePath)

  const envAuthenticated = Boolean(
    process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY || process.env.CODEX_ACCESS_TOKEN,
  )
  if (envAuthenticated) {
    return {
      installed: true,
      authStatus: 'authenticated',
      sdkVersion,
      cliVersion,
      detail: 'Codex API credentials are present in the server environment.',
    }
  }

  try {
    const login = await runCodexLoginStatus(executablePath)
    if (login.ok && /logged in/i.test(login.output)) {
      return { installed: true, authStatus: 'authenticated', sdkVersion, cliVersion, detail: login.output.split('\n')[0] || 'Codex login is configured.' }
    }
    if (login.ok) {
      return { installed: true, authStatus: 'missing', sdkVersion, cliVersion, detail: login.output.split('\n')[0] || 'Codex login is not configured.' }
    }
    return { installed: true, authStatus: 'unknown', sdkVersion, cliVersion, detail: login.output || 'Codex CLI found, but login status could not be checked.' }
  } catch (error) {
    return { installed: true, authStatus: 'unknown', sdkVersion, cliVersion, detail: error instanceof Error ? error.message : String(error) }
  }
}

async function runCodexVersion(executablePath: string): Promise<string | undefined> {
  const result = await runCodexCommand(executablePath, ['--version'], 5_000)
  if (!result.ok) return undefined
  return /\bcodex-cli\s+(\S+)/i.exec(result.output)?.[1]
}

async function resolveCodexSdkVersion(): Promise<string | undefined> {
  try {
    const require = createRequire(import.meta.url)
    let dir = dirname(require.resolve('@openai/codex-sdk'))
    const root = parse(dir).root

    while (dir !== root) {
      try {
        const raw = await readFile(join(dir, 'package.json'), 'utf8')
        const packageJson = JSON.parse(raw) as { name?: string; version?: string }
        if (packageJson.name === '@openai/codex-sdk') return packageJson.version
      } catch {
        /* keep walking */
      }
      dir = dirname(dir)
    }
  } catch {
    /* version is informational only */
  }
  return undefined
}

async function runCodexLoginStatus(executablePath: string): Promise<{ ok: boolean; output: string }> {
  return runCodexCommand(executablePath, ['login', 'status'], 5_000)
}

async function runCodexCommand(executablePath: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; output: string }> {
  return await new Promise((resolve) => {
    const child = spawn(executablePath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })
    const chunks: Buffer[] = []
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ ok: false, output: 'Codex command timed out.' })
    }, timeoutMs)

    child.stdout?.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    child.stderr?.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    child.once('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, output: error.message })
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({
        ok: code === 0,
        output: Buffer.concat(chunks).toString('utf8').trim(),
      })
    })
  })
}

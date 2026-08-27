import { getCodexServer } from '../codex/appServer'
import { codexExecutableSource, resolveCodexExecutable } from '../codex/bin'

export type CodexAuthStatus = 'authenticated' | 'missing' | 'unknown'

export type CodexSdkStatus = {
  installed: boolean
  authStatus: CodexAuthStatus
  detail: string // human-readable only when something is wrong (not installed / not logged in / probe failed)
  authMethod?: string // e.g. chatgpt / apiKey
  binSource?: string // vendored / packaged / env / path
  binPath?: string
  sdkVersion?: string // kept for the UI: now the app-server protocol version (same binary as cliVersion)
  cliVersion?: string
}

let _cache: { value: CodexSdkStatus; at: number } | null = null
const TTL = 60_000

// Installed = the binary resolves; version + auth come from the live app-server handshake (`initialize` +
// `getAuthStatus`) instead of spawning `codex --version` / `codex login status`.
export async function getCodexSdkStatus(force = false): Promise<CodexSdkStatus> {
  if (!force && _cache && Date.now() - _cache.at < TTL) return _cache.value

  const value = await resolveCodexSdkStatus()
  _cache = { value, at: Date.now() }
  return value
}

async function resolveCodexSdkStatus(): Promise<CodexSdkStatus> {
  const executablePath = resolveCodexExecutable()
  if (!executablePath) {
    return {
      installed: false,
      authStatus: 'unknown',
      detail: '找不到 Codex CLI 二进制。请确认 `pnpm install` 装上了 @openai/codex 的平台包，或设置 CODEX_EXECUTABLE 指向 codex 可执行文件。',
    }
  }
  try {
    const server = await getCodexServer()
    const cliVersion = server.version ?? undefined
    const auth = await server.rpc.request('getAuthStatus', { includeToken: false, refreshToken: false }, 10_000)
    const method = auth?.authMethod as string | null | undefined
    const source = codexExecutableSource()
    const where = `binary: ${source ?? '?'} (${executablePath})`
    const bin = { authMethod: method || undefined, binSource: source ?? undefined, binPath: executablePath }
    if (method) return { installed: true, authStatus: 'authenticated', cliVersion, sdkVersion: cliVersion, detail: '', ...bin }
    return { installed: true, authStatus: 'missing', cliVersion, sdkVersion: cliVersion, detail: `Codex is not logged in (run \`codex login\`). ${where}`, ...bin }
  } catch (error) {
    return { installed: true, authStatus: 'unknown', detail: error instanceof Error ? error.message : String(error) }
  }
}

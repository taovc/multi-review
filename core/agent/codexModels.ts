import { spawn } from 'node:child_process'
import { resolveCodexExecutable } from './codexAgent'

// 从 `codex debug models` 读「当前账号真实可用」的模型（含每个模型支持的 reasoning effort 档）。
// 不硬编码：ChatGPT 登录 vs API key 能用的模型不同，只有 CLI 知道真相。
export type CodexModel = {
  value: string // slug，传给 -m / SDK 的 model
  displayName: string
  description: string
  supportsEffort: boolean
  effortLevels: string[]
}

let _cache: { value: CodexModel[]; at: number } | null = null
const TTL = 5 * 60_000

export async function getCodexModels(force = false): Promise<CodexModel[]> {
  if (!force && _cache && Date.now() - _cache.at < TTL) return _cache.value
  const value = await resolveCodexModels()
  if (value.length) _cache = { value, at: Date.now() } // 只缓存非空结果，免得一次失败把空列表缓存住
  return value
}

async function resolveCodexModels(): Promise<CodexModel[]> {
  const bin = resolveCodexExecutable()
  if (!bin) return []
  const raw = await runDebugModels(bin).catch(() => '')
  return parseCodexModels(raw)
}

export function parseCodexModels(raw: string): CodexModel[] {
  if (!raw.trim()) return []
  let parsed: { models?: unknown }
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  const models = Array.isArray(parsed.models) ? (parsed.models as Array<Record<string, any>>) : []
  const rank = (m: Record<string, any>) => (typeof m.priority === 'number' ? m.priority : Number.MAX_SAFE_INTEGER)
  return models
    .filter((m) => m && m.visibility === 'list' && typeof m.slug === 'string')
    .sort((a, b) => rank(a) - rank(b)) // priority 越小越靠前（5.5=9 frontier 排第一）
    .map((m): CodexModel => {
      const effortLevels = Array.isArray(m.supported_reasoning_levels)
        ? (m.supported_reasoning_levels as Array<Record<string, any>>)
            .map((r) => r?.effort)
            .filter((e): e is string => typeof e === 'string')
        : []
      return {
        value: m.slug,
        displayName: m.display_name || m.slug,
        description: m.description || '',
        supportsEffort: effortLevels.length > 0,
        effortLevels,
      }
    })
}

// Ultracode 开关优先使用模型目录声明的原生 ultra；旧模型或未知模型保持原来的 xhigh 行为。
// 空模型表示走 Codex 默认，此时用目录优先级最高的模型能力作为判断依据。
export function codexUltracodeEffort(models: CodexModel[], model?: string): 'ultra' | 'xhigh' {
  const selected = model
    ? models.find((m) => m.value === model)
      || (model === 'gpt-5.6' ? models.find((m) => m.value === 'gpt-5.6-sol') : undefined)
    : models[0]
  return selected?.effortLevels.includes('ultra') ? 'ultra' : 'xhigh'
}

function runDebugModels(bin: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(bin, ['debug', 'models'], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
    const chunks: Buffer[] = []
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve('')
    }, 10_000)
    child.stdout?.on('data', (c) => chunks.push(Buffer.from(c)))
    child.once('error', () => {
      clearTimeout(timer)
      resolve('')
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve(code === 0 ? Buffer.concat(chunks).toString('utf8') : '')
    })
  })
}

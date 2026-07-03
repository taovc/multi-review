import { existsSync, readdirSync } from 'node:fs'
import { join, delimiter } from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { Codex, type ModelReasoningEffort, type ThreadEvent, type ThreadOptions } from '@openai/codex-sdk'
import { extractCodexErrorMessage } from './codexErrors'

const DEFAULT_PROJECT_DOC_FALLBACKS = ['CLAUDE.md', '.claude/CLAUDE.md']
const DEFAULT_PROJECT_DOC_MAX_BYTES = 64 * 1024
export type CodexServiceTier = 'fast'
export type CodexConfigOverrides = { serviceTier?: CodexServiceTier | string | null }

// 把 UI 的 effort（含 max）映射到 Codex SDK 的档位；空/不认识则交给 SDK 默认。
export function toCodexEffort(effort?: string): ModelReasoningEffort | undefined {
  if (effort === 'minimal' || effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'xhigh') return effort
  if (effort === 'max') return 'xhigh'
  return undefined
}

function splitConfigList(value?: string): string[] {
  return (value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export function codexCliConfig(env: NodeJS.ProcessEnv = process.env, overrides?: CodexConfigOverrides): Record<string, string | number | boolean | string[]> {
  const fallbacks = splitConfigList(env.CODEX_PROJECT_DOC_FALLBACK_FILENAMES)
  const maxBytes = Number(env.CODEX_PROJECT_DOC_MAX_BYTES)
  const rawServiceTier = overrides && 'serviceTier' in overrides ? overrides.serviceTier : env.CODEX_SERVICE_TIER
  const serviceTier = (rawServiceTier || '').trim()
  const config: Record<string, string | number | boolean | string[]> = {
    project_doc_fallback_filenames: fallbacks.length ? fallbacks : DEFAULT_PROJECT_DOC_FALLBACKS,
    project_doc_max_bytes: Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : DEFAULT_PROJECT_DOC_MAX_BYTES,
  }
  if (serviceTier) config.service_tier = serviceTier
  return config
}

function isGitWorkTree(cwd: string): boolean {
  try {
    execFileSync('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export function codexWorkingDirectoryOptions(cwd?: string): Pick<ThreadOptions, 'workingDirectory' | 'skipGitRepoCheck'> {
  if (!cwd) return { skipGitRepoCheck: true }
  return isGitWorkTree(cwd)
    ? { workingDirectory: cwd }
    : { workingDirectory: cwd, skipGitRepoCheck: true }
}

// 平台 → Rust target triple（Codex 二进制放在 vendor/<triple>/bin/codex 下）。
const CODEX_TARGET_TRIPLE: Record<string, string> = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'win32-x64': 'x86_64-pc-windows-msvc',
}

// 从「项目真实 node_modules」(process.cwd()) 按文件查 Codex CLI 二进制路径。
// 为什么需要：nitro 生产构建只把 @openai/codex-sdk 的 JS 打进 .output，没带平台二进制包
// （@openai/codex 及 @openai/codex-<platform>-<arch>）。SDK 自带解析基于打包后的 import.meta.url，
// 在 .output 里找不到二进制 → new Codex() 会抛「Unable to locate Codex CLI binaries」。
// 这里直接在 node_modules 里按文件找二进制，跟打包方式无关；找到后显式传给 codexPathOverride。
// 不用 require.resolve：@openai/codex-sdk 是 ESM-only、exports 不暴露 package.json，CJS 解析会失败。
function codexBinCandidates(triple: string, binName: string): string[] {
  const cwd = process.cwd()
  const key = `${process.platform}-${process.arch}`
  const out: string[] = []
  // pnpm store：.pnpm/@openai+codex@<ver>-<platform>-<arch>/node_modules/@openai/codex/vendor/<triple>/bin/codex
  const pnpmDir = join(cwd, 'node_modules', '.pnpm')
  try {
    for (const entry of readdirSync(pnpmDir)) {
      if (entry.startsWith('@openai+codex@') && entry.endsWith(`-${key}`)) {
        out.push(join(pnpmDir, entry, 'node_modules', '@openai', 'codex', 'vendor', triple, 'bin', binName))
      }
    }
  } catch { /* 没有 .pnpm 目录（非 pnpm 布局）→ 走下面的 hoisted 候选 */ }
  // npm/yarn 扁平布局
  out.push(join(cwd, 'node_modules', '@openai', `codex-${key}`, 'vendor', triple, 'bin', binName))
  out.push(join(cwd, 'node_modules', '@openai', 'codex', 'vendor', triple, 'bin', binName))
  return out
}

// production 兜底：node_modules 里没 vendor 二进制时（打包后 cwd 不在项目根），
// 用 PATH / 常见安装目录里用户全局装的 codex CLI。和 claude-bin 的 fromPath 对称。
function codexFromPath(binName: string): string | undefined {
  const dirs = (process.env.PATH || '').split(delimiter)
  dirs.push(join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin')
  for (const d of dirs) {
    if (!d) continue
    const p = join(d, binName)
    if (existsSync(p)) return p
  }
  return undefined
}

let _codexBin: string | null | undefined
export function resolveCodexExecutable(): string | undefined {
  if (_codexBin !== undefined) return _codexBin ?? undefined
  const envBin = process.env.CODEX_EXECUTABLE
  if (envBin && existsSync(envBin)) return (_codexBin = envBin)
  const triple = CODEX_TARGET_TRIPLE[`${process.platform}-${process.arch}`]
  if (triple) {
    const binName = process.platform === 'win32' ? 'codex.exe' : 'codex'
    for (const cand of codexBinCandidates(triple, binName)) {
      if (existsSync(cand)) return (_codexBin = cand)
    }
    const fromPath = codexFromPath(binName)
    if (fromPath) return (_codexBin = fromPath)
  }
  _codexBin = null
  return undefined
}

// 有本地 OpenAI key 就用 key；否则交给 Codex CLI 的本地登录（不覆盖 env，让它继承 gh/codex 凭据）。
// codexPathOverride：显式指向解析到的二进制，绕开 nitro 打包后找不到二进制的问题。
export function newCodex(overrides?: CodexConfigOverrides): Codex {
  const executablePath = resolveCodexExecutable()
  return new Codex({
    ...(executablePath ? { codexPathOverride: executablePath } : {}),
    config: codexCliConfig(process.env, overrides),
    ...(process.env.OPENAI_API_KEY ? { apiKey: process.env.OPENAI_API_KEY } : {}),
  })
}

// 禁止的本地/远端写操作：git 写、gh 的 review/comment/merge 等、以及 gh api 的写方法。
// Codex 跑命令是「事后」检测（命令已执行），配合上传门控/HEAD 校验做多层防御。
export function isForbiddenRemoteOrGitMutation(command: string): boolean {
  return /\bgit\s+(?:add|commit|push|reset|checkout|switch|merge|rebase|tag)\b/i.test(command)
    || /\bgh\s+pr\s+(?:create|review|comment|merge|close|edit|ready|reopen)\b/i.test(command)
    || /\bgh\s+api\b.*(?:--method|-X)\s*(?:POST|PUT|PATCH|DELETE)\b/i.test(command)
}

// 只读 agent 阶段（首审 / 反馈复审 / 复审 / Skill 生成）的事件处理：
// - turn.failed / error / error item → 抛错
// - command_execution → 出日志 + 拦截写操作
// - file_change（理论上 read-only 不会有）/ mcp / web_search → 出日志
// - agent_message（item.completed）→ 返回最终文本（JSON 或 markdown 正文）
function emitReadonlyEvent(event: ThreadEvent, label: string, onTool?: (name: string, info: string) => void): string | null {
  if (event.type === 'turn.failed') throw new Error(`Codex ${label} turn failed: ${extractCodexErrorMessage(event.error.message)}`)
  if (event.type === 'error') throw new Error(`Codex ${label} stream failed: ${extractCodexErrorMessage(event.message)}`)
  if (event.type !== 'item.completed') return null

  const { item } = event
  if (item.type === 'command_execution') {
    onTool?.('CodexCommand', item.command.slice(0, 100))
    if (isForbiddenRemoteOrGitMutation(item.command)) {
      throw new Error(`Codex ${label} attempted a forbidden git/GitHub mutation: ${item.command}`)
    }
  } else if (item.type === 'file_change') {
    onTool?.('CodexFileChange', item.changes.map((c) => `${c.kind}:${c.path}`).join(', ').slice(0, 100))
  } else if (item.type === 'mcp_tool_call') {
    onTool?.('CodexMcp', `${item.server}.${item.tool}`.slice(0, 100))
  } else if (item.type === 'web_search') {
    onTool?.('CodexWebSearch', item.query.slice(0, 100))
  } else if (item.type === 'agent_message') {
    return item.text
  } else if (item.type === 'error') {
    // ErrorItem 在 SDK 里是「非致命」错误（如 codex 插件 hooks 解析告警）。出日志、不中断。
    // 致命情况由 turn.failed / 顶层 error 事件（上面已抛）或「无最终输出」（调用方抛）兜底。
    onTool?.('CodexWarning', item.message.slice(0, 140))
  }
  return null
}

// 跑一个「只读」Codex agent：read-only 沙箱、approval=never、可选放开网络（让 gh 能读 PR 评论）。
// 带 outputSchema 时强制结构化 JSON。返回最终 agent_message 文本（由调用方解析）。
export async function runCodexReadonly(opts: {
  prompt: string
  cwd?: string
  model?: string
  effort?: string
  serviceTier?: CodexServiceTier | string | null
  outputSchema?: unknown
  allowNetwork?: boolean // 复审/反馈复审要用 gh 读评论 → 放开网络（写操作仍被命令守卫拦截）
  label: string
  onTool?: (name: string, info: string) => void
  onStop?: (stop: () => void) => void // 暴露中断回调：停止时打标记，事件循环检测到就中断消费（feature 分析阶段的停止按钮用）
}): Promise<string> {
  const codex = newCodex('serviceTier' in opts ? { serviceTier: opts.serviceTier } : undefined)
  const effort = toCodexEffort(opts.effort)
  const thread = codex.startThread({
    ...(opts.model ? { model: opts.model } : {}),
    ...(effort ? { modelReasoningEffort: effort } : {}),
    ...codexWorkingDirectoryOptions(opts.cwd),
    sandboxMode: 'read-only',
    approvalPolicy: 'never',
    networkAccessEnabled: !!opts.allowNetwork,
    webSearchMode: 'disabled',
    webSearchEnabled: false,
  })

  // 停止：codex SDK 没有显式 abort，靠标记 + 下个事件到达时抛错中断 for-await（会触发 events.return() 清理）。
  // codex 调研会频繁出 command/reasoning 事件，所以中断很快生效。
  let aborted = false
  opts.onStop?.(() => { aborted = true })

  const { events } = await thread.runStreamed(opts.prompt, opts.outputSchema ? { outputSchema: opts.outputSchema } : {})
  let raw = ''
  for await (const event of events) {
    if (aborted) throw new Error(`Codex ${opts.label} 已被用户停止`)
    const text = emitReadonlyEvent(event, opts.label, opts.onTool)
    if (text != null) raw = text
  }
  if (aborted) throw new Error(`Codex ${opts.label} 已被用户停止`)
  if (!raw.trim()) throw new Error(`Codex ${opts.label} returned no final response.`)
  return raw
}

// 一次性文本生成（发评论翻译）：read-only、无网络、不需要流式工具进度。返回最终文本。
export async function runCodexText(opts: {
  prompt: string
  cwd?: string
  model?: string
  effort?: string
  serviceTier?: CodexServiceTier | string | null
}): Promise<string> {
  const codex = newCodex('serviceTier' in opts ? { serviceTier: opts.serviceTier } : undefined)
  const effort = toCodexEffort(opts.effort)
  const thread = codex.startThread({
    ...(opts.model ? { model: opts.model } : {}),
    ...(effort ? { modelReasoningEffort: effort } : {}),
    ...codexWorkingDirectoryOptions(opts.cwd),
    sandboxMode: 'read-only',
    approvalPolicy: 'never',
    networkAccessEnabled: false,
    webSearchMode: 'disabled',
    webSearchEnabled: false,
  })
  const turn = await thread.run(opts.prompt)
  return (turn.finalResponse || '').trim()
}

// Codex configuration helpers shared by the app-server host (core/codex) and the transparency page. The SDK runner
// that used to live here is gone: every Codex call now goes through the host (core/codex/codexHost.ts) or its
// one-shot wrappers (core/codex/oneshot.ts).
export { isForbiddenRemoteOrGitMutation } from './commandGuard'
export { resolveCodexExecutable } from '../codex/bin'

const DEFAULT_PROJECT_DOC_FALLBACKS = ['CLAUDE.md', '.claude/CLAUDE.md']
const DEFAULT_PROJECT_DOC_MAX_BYTES = 64 * 1024
export type CodexServiceTier = 'fast'
export type CodexReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'
export type CodexConfigOverrides = {
  serviceTier?: CodexServiceTier | string | null
  reasoningEffort?: CodexReasoningEffort | null
}

const CODEX_REASONING_EFFORTS = new Set<CodexReasoningEffort>(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])

// Only accept efforts the CLI model catalog can return; empty/unknown falls back to Codex's default.
export function toCodexEffort(effort?: string): CodexReasoningEffort | undefined {
  return CODEX_REASONING_EFFORTS.has(effort as CodexReasoningEffort) ? effort as CodexReasoningEffort : undefined
}

function splitConfigList(value?: string): string[] {
  return (value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

// `-c key=value` overrides passed to the app-server process (project doc fallbacks so a CLAUDE.md-only repo still
// gives Codex its instructions; optional service tier / effort for callers that build per-run config).
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
  const reasoningEffort = toCodexEffort(overrides?.reasoningEffort || undefined)
  if (reasoningEffort) config.model_reasoning_effort = reasoningEffort
  return config
}

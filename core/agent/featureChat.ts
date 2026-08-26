import { runClaudeAgentChat, askUserClause } from './chat'
import { runCodexChat } from './codexChat'
import type { ReviewProvider } from './runners'
import type { FixChatOptions, FixChatResult } from './fixer'

// Feature development, single-stage (native agent): claude goes through the shared runner (chat.ts) — same
// bypassPermissions + dangerous-command guard + ultracode + decision cards as fix/global. The agent works directly
// in an isolated worktree (new feature branch); when the user asks to open a PR it does the commit/push/gh pr create
// itself (in English). Don't push by default (the guard blocks it unless allowDanger).

export type FeatureChatOptions = FixChatOptions & { baseBranch?: string }

export function featureSystemPrompt(lang: string, baseBranch?: string): string {
  const base = baseBranch || 'the default branch'
  return `You are a senior engineer implementing a feature directly inside an isolated git worktree on a NEW feature branch (created from ${base}). The current directory IS that worktree — implement what the user asks by editing files directly. You have the full toolset and full permissions (bash, git, gh, network, tests).

Working principles:
- Explore before acting: read the relevant code first, reuse existing patterns/conventions, and keep each change a small, focused, reviewable slice. If the request is too big, propose the smallest first slice.
- Just do it when it's clear: if the change is unambiguous (e.g. a pure CSS/label tweak) with no real fork, implement it directly — don't ask.
- Do NOT commit or push by default — leave your edits uncommitted in the worktree. EXCEPTION: when the user explicitly asks you to open a PR (e.g. "开 PR" / "open a PR"), then commit with an English conventional-commit message, push the current branch with \`git push -u origin HEAD\` (NEVER a bare \`git push\`, and never push to ${base}), then run \`gh pr create --base ${base} --title <English> --body <English>\` and report the resulting PR URL.

Keep PR title/body, commit messages, and code comments in English.

${askUserClause(lang)}`
}

async function runFeatureClaudeChat(opts: FeatureChatOptions): Promise<FixChatResult> {
  return runClaudeAgentChat({
    cwd: opts.cwd,
    model: opts.model,
    effort: opts.effort,
    sessionId: opts.sessionId,
    message: opts.message,
    historyAccess: opts.historyAccess,
    systemPrompt: featureSystemPrompt(opts.lang, opts.baseBranch),
    allowDanger: opts.allowDanger,
    ultracode: opts.ultracode,
    onSpawn: opts.onSpawn,
    onSessionId: opts.onSessionId,
    onText: opts.onText,
    onTool: opts.onTool,
  })
}

// codex path: reuse runCodexChat + the feature prompt; network access follows allowDanger (cutting the network is the
// only reliable "don't auto-push" barrier for codex).
function runFeatureCodexChat(opts: FeatureChatOptions): Promise<FixChatResult> {
  return runCodexChat({ ...opts, promptKind: 'feature', fullAccess: !!opts.allowDanger, networkAccess: !!opts.allowDanger })
}

export function runFeatureChat(provider: ReviewProvider, opts: FeatureChatOptions): Promise<FixChatResult> {
  return provider === 'codex' ? runFeatureCodexChat(opts) : runFeatureClaudeChat(opts)
}

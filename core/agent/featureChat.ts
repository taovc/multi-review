import { runClaudeAgentChat, askUserClause } from './chat'
import { runCodexChat } from './codexChat'
import type { ReviewProvider } from './runners'
import type { FixChatOptions, FixChatResult } from './fixer'

// Feature 开发 · 单段式（原生 agent）：claude 走共享运行器（chat.ts）——统一 bypassPermissions + 危险命令守卫
// + ultracode + 决策卡（同 fix/global）。agent 直接在隔离 worktree（新功能分支）动手；用户让「开 PR」时自己
// commit/push/gh pr create（英文）。默认别 push（守卫会拦，除非 allowDanger）。

export type FeatureChatOptions = FixChatOptions & { baseBranch?: string }

function featureSystemPrompt(lang: string, baseBranch?: string): string {
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

// codex 路径：复用 runCodexChat + feature prompt；联网跟 allowDanger 走（断网 = codex 唯一可靠的「不自动推」屏障）。
function runFeatureCodexChat(opts: FeatureChatOptions): Promise<FixChatResult> {
  return runCodexChat({ ...opts, promptKind: 'feature', fullAccess: !!opts.allowDanger, networkAccess: !!opts.allowDanger })
}

export function runFeatureChat(provider: ReviewProvider, opts: FeatureChatOptions): Promise<FixChatResult> {
  return provider === 'codex' ? runFeatureCodexChat(opts) : runFeatureClaudeChat(opts)
}

import { runClaudeAgentChat, askUserClause, type AgentChatResult } from './chat'
import type { ChildProcess } from 'node:child_process'

// Fixing a PR = talking to the agent inside the PR worktree and letting it edit files directly.
// claude goes through the shared runner (chat.ts): the same bypassPermissions + dangerous-command
// guard + ultracode + decision cards (as feature/global). No automatic commit: the changes stay in
// the worktree, and only when the user clicks "Commit and upload" do they get committed and pushed
// (via the Node path in push.post.ts).

export type FixChatOptions = {
  cwd: string
  model: string
  effort?: string
  codexServiceTier?: string | null
  lang: string
  sessionId: string | null // present → --resume; absent → start a new session
  message: string
  historyAccess?: string
  conflictHint?: string
  // ── switches shared with feature development / dangerous commands / ultracode ──
  promptKind?: 'fix' | 'feature' | 'global' // codex's respective prompts: fix=fix a PR / feature=develop on a new branch / global=free-form assistant
  baseBranch?: string // feature: the target branch when opening the PR
  fullAccess?: boolean // codex: true → danger-full-access sandbox (otherwise workspace-write)
  networkAccess?: boolean // codex: true → allow network + web search
  allowDanger?: boolean // claude: let the dangerous-command guard through (including git push / gh pr create), blocked by default
  ultracode?: boolean // activate ultracode in the background (the prefix is injected by the shared runner)
  onSpawn?: (cp: ChildProcess) => void
  onStop?: (stop: () => void) => void
  onSessionId?: (sessionId: string) => void
  onText?: (text: string) => void
  onTool?: (name: string, info: string) => void
}

export type FixChatResult = AgentChatResult

// Fix methodology: make the reviewer's requested touch-ups inside the PR branch worktree; by default
// don't commit/push.
function fixSystemPrompt(lang: string, conflictHint?: string): string {
  return `You're working on this pull request inside its git worktree (the current directory is the PR branch checked out). Make the changes the reviewer asks for by editing files directly. You have the full toolset — bash, git, gh, network, tests — so investigate the PR whenever it helps (e.g. \`gh pr view\`, run the tests).
${conflictHint ? `\n${conflictHint}\n` : ''}
Do NOT commit or push. The reviewer reviews your edits in the UI and clicks "Upload", which commits and pushes for them. (Only push if the user explicitly asks.)

${askUserClause(lang)}`
}

export async function runFixChat(opts: FixChatOptions): Promise<FixChatResult> {
  return runClaudeAgentChat({
    cwd: opts.cwd,
    model: opts.model,
    effort: opts.effort,
    sessionId: opts.sessionId,
    message: opts.message,
    historyAccess: opts.historyAccess,
    systemPrompt: fixSystemPrompt(opts.lang, opts.conflictHint),
    allowDanger: opts.allowDanger,
    ultracode: opts.ultracode,
    onSpawn: opts.onSpawn,
    onSessionId: opts.onSessionId,
    onText: opts.onText,
    onTool: opts.onTool,
  })
}

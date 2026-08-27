import { RECOMMENDED_MARKER } from '../agent/decisionCard'

// Codex has no "ultracode" harness keyword: the deep-work workflow is spelled out in the developer instructions and the
// reasoning effort is raised separately (see codexUltracodeEffort).
export function codexUltracodePrompt(kind: 'fix' | 'feature' | 'global'): string {
  const askUser = kind === 'feature'
    ? `- Ask ONLY on genuine decision points: architecture, data model, external contract, or a real user-facing tradeoff. When you must ask, STOP and emit exactly one fenced block, then end the turn:
\`\`\`ask-user
<your question in one or two lines>
- <option A>
- <option B ${RECOMMENDED_MARKER}>
\`\`\`
  Mark the recommended option by appending the literal marker ${RECOMMENDED_MARKER} — keep it verbatim in English even when the rest of your reply is in another language.`
    : '- If you hit a real blocker or need a product decision, stop and state the exact question clearly; do not invent requirements.'

  return `Ultracode mode is enabled for this Codex turn.
- Use deep reasoning and a deliberate implementation workflow: inspect the relevant project docs first, then read the actual code before editing.
- Keep a concise internal todo list for multi-step work, but keep the final reply brief.
- Prefer the smallest complete, reviewable slice over broad rewrites.
- Verify with targeted tests or checks when practical; if you cannot run them, say exactly why.
${askUser}`
}

// Codex runs without the Node-side upload path knowing about it: spell out the git contract the fix/feature flows rely on.
export function codexSessionContract(kind: 'fix' | 'feature' | 'global'): string {
  if (kind === 'global') return ''
  if (kind === 'feature') return 'Leave your edits uncommitted in the worktree unless the user explicitly asks you to open a PR. Never run a bare `git push` (push with `git push -u origin HEAD` only when asked).'
  return 'Leave edits unstaged and uncommitted: the reviewer inspects the diff in the UI and uploads it. Do NOT run git add/commit/push, gh pr review/comment/merge, or gh api mutations.'
}

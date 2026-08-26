import { langName } from './lang'
import { RECOMMENDED_MARKER } from './decisionCard'

// Prompt fragments shared by every session kind (PR worktree / feature branch / working directory). The turns themselves run
// on the session hosts (core/runs/session.ts); the old per-turn `claude -p` runner that lived here is gone.

// Decision-card convention (identical across all three): on a genuine fork, emit one ```ask-user fenced block and end the turn; the frontend parses it into a decision card (clicking an option = the next message, resuming the session).
// This block is concatenated into each chat's systemPrompt. Both claude and codex use it, with identical behavior.
export function askUserClause(lang: string): string {
  return `When you hit a GENUINE decision point — a real fork such as architecture, data model, an external contract, or a user-facing tradeoff — STOP and emit EXACTLY one fenced block, then END your turn and wait (the user's answer arrives as the next message):
\`\`\`ask-user
<your question in one or two lines>
- <option A>
- <option B ${RECOMMENDED_MARKER}>
\`\`\`
Mark your recommended option by appending the literal marker ${RECOMMENDED_MARKER} — keep it verbatim in English even when the rest of your reply is in another language. Ask sparingly, batch related questions, and never ask about details you can decide yourself. Respond in ${langName(lang)}.`
}

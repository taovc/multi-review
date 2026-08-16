// Decision-card protocol, shared by the agent prompts (fix / feature / global, on both
// Claude and Codex) and by the three chat UIs that render the cards.
//
// The agent appends a literal marker to the option it recommends. The UI shows the marker
// on the button but strips it before echoing the option back as the next message, so the
// marker never travels back into the conversation.
//
// Keep this module dependency-free: it is imported by Vue components through the `~core`
// alias and must not pull server-only code into the client bundle.

// The marker the prompts ask the agent to emit.
export const RECOMMENDED_MARKER = '(recommended)'

// Strips the marker off an option label. Accepts the legacy Chinese marker as well, so
// decision cards produced before the prompts were switched to English still round-trip,
// and so a model that localises the marker despite the instruction is still handled.
// Both full-width and ASCII parentheses are accepted.
const RECOMMENDED_MARKER_RE = /\s*[（(]\s*(?:recommended|推荐)\s*[)）]\s*$/i

export function stripRecommendedMarker(option: string): string {
  return option.replace(RECOMMENDED_MARKER_RE, '')
}

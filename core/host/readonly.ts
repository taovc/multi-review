import type { CanUseTool, HookCallback } from '@anthropic-ai/claude-agent-sdk'
import { isDangerousBash } from '../agent/guard'

// Read-only policy for the review family (review / guided / recheck / skillgen). Three independent layers, any one of
// which is enough on its own:
//   1. a PreToolUse hook (runs before permission rules, so a user "allow" rule cannot bypass it) — reviewGuardHook
//   2. inline `settings` deny rules + disableAllHooks (the user's own hooks are the only vector that could execute code
//      inside the review worktree) — REVIEW_DENY_RULES
//   3. disallowedTools + canUseTool + permissionMode 'default' — REVIEW_DISALLOWED_TOOLS / reviewCanUseTool
// Unlike the old ISOLATED mode the user's configuration (CLAUDE.md, rules, skills, MCP, plugins) is loaded; MCP tools are
// denied unless the agent-config screen's "reviews may use MCP" switch is on (then every configured server is callable —
// an opt-in the owner made knowingly: MCP tools can write to external systems and reviews run unattended).

export const READONLY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'Skill', 'TodoWrite', 'Task', 'TaskOutput', 'TaskStop', 'StructuredOutput']) // StructuredOutput = how the CLI delivers outputFormat json_schema results

export const REVIEW_DISALLOWED_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'ExitPlanMode', 'EnterPlanMode']

export const REVIEW_DENY_RULES = [
  ...REVIEW_DISALLOWED_TOOLS,
  'Bash(git push:*)', 'Bash(git commit:*)', 'Bash(git add:*)', 'Bash(git reset:*)', 'Bash(git rebase:*)', 'Bash(git merge:*)',
  'Bash(git checkout:*)', 'Bash(git switch:*)', 'Bash(git restore:*)', 'Bash(git stash:*)', 'Bash(git clean:*)', 'Bash(git worktree:*)',
  'Bash(gh pr comment:*)', 'Bash(gh pr review:*)', 'Bash(gh pr merge:*)', 'Bash(gh pr close:*)', 'Bash(gh pr edit:*)', 'Bash(gh pr create:*)',
  'Bash(gh issue comment:*)', 'Bash(gh issue create:*)', 'Bash(gh issue close:*)', 'Bash(gh issue edit:*)',
  'Bash(rm:*)', 'Bash(sudo:*)', 'Bash(curl:*)', 'Bash(wget:*)',
]

export type Verdict = { ok: true } | { ok: false; reason: string }

function mcpServerOf(toolName: string): string | null {
  const m = toolName.match(/^mcp__([^_]+(?:_[^_]+)*?)__/)
  return m ? m[1]! : null
}

// The single decision function behind layers 1 and 3.
export function reviewVerdict(toolName: string, input: unknown, mcp: boolean): Verdict {
  if (READONLY_TOOLS.has(toolName)) return { ok: true }
  if (toolName === 'Bash') {
    const cmd = String((input as any)?.command ?? '')
    if (isDangerousBash(cmd)) return { ok: false, reason: `read-only review: blocked command "${cmd.slice(0, 100)}"` }
    return { ok: true }
  }
  if (toolName.startsWith('mcp__')) {
    if (mcp) return { ok: true }
    return { ok: false, reason: `read-only review: MCP is off for reviews (tool ${toolName}, server ${mcpServerOf(toolName) ?? '?'})` }
  }
  if (toolName === 'ListMcpResourcesTool' || toolName === 'ReadMcpResourceTool') {
    if (mcp) return { ok: true }
    return { ok: false, reason: `read-only review: MCP is off for reviews (server ${String((input as any)?.server ?? '?')})` }
  }
  return { ok: false, reason: `read-only review: tool ${toolName} is not allowed` }
}

export function makeReviewCanUseTool(mcp: boolean): CanUseTool {
  return async (toolName, input) => {
    const v = reviewVerdict(toolName, input, mcp)
    if (v.ok) return { behavior: 'allow', updatedInput: input }
    return { behavior: 'deny', message: `Denied by PR Cockpit security policy — ${v.reason}`, interrupt: false }
  }
}

// Layer 1: a hook decision beats every permission rule; anything not denied here still goes through layers 2 and 3.
export function makeReviewGuardHook(mcp: boolean): HookCallback {
  return async (input) => {
    if ((input as any)?.hook_event_name !== 'PreToolUse') return {}
    const toolName = String((input as any).tool_name ?? '')
    const v = reviewVerdict(toolName, (input as any).tool_input, mcp)
    if (v.ok) return {}
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `PR Cockpit read-only guard — ${v.reason}` } }
  }
}

import type { CanUseTool, HookCallback } from '@anthropic-ai/claude-agent-sdk'
import { isDangerousBash } from '../agent/guard'

// Read-only policy for the review family (review / guided / recheck / skillgen). Three independent layers, any one of
// which is enough on its own:
//   1. a PreToolUse hook (runs before permission rules, so a user "allow" rule cannot bypass it) — reviewGuardHook
//   2. inline `settings` deny rules + disableAllHooks (the user's own hooks are the only vector that could execute code
//      inside the review worktree) — REVIEW_DENY_RULES
//   3. disallowedTools + canUseTool + permissionMode 'default' — REVIEW_DISALLOWED_TOOLS / reviewCanUseTool
// Unlike the old ISOLATED mode the user's configuration (CLAUDE.md, rules, skills, MCP, plugins) is loaded; MCP tools are
// denied unless their server is on the read-only allow list from the agent-config screen.

export const READONLY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'Skill', 'TodoWrite', 'Task', 'TaskOutput', 'TaskStop'])

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
export function reviewVerdict(toolName: string, input: unknown, mcpAllow: string[]): Verdict {
  if (READONLY_TOOLS.has(toolName)) return { ok: true }
  if (toolName === 'Bash') {
    const cmd = String((input as any)?.command ?? '')
    if (isDangerousBash(cmd)) return { ok: false, reason: `read-only review: blocked command "${cmd.slice(0, 100)}"` }
    return { ok: true }
  }
  if (toolName.startsWith('mcp__')) {
    const server = mcpServerOf(toolName)
    if (server && mcpAllow.includes(server)) return { ok: true }
    return { ok: false, reason: `read-only review: MCP server "${server ?? toolName}" is not on the read-only allow list` }
  }
  if (toolName === 'ListMcpResourcesTool' || toolName === 'ReadMcpResourceTool') {
    const server = String((input as any)?.server ?? '')
    if (server && mcpAllow.includes(server)) return { ok: true }
    return { ok: false, reason: `read-only review: MCP server "${server}" is not on the read-only allow list` }
  }
  return { ok: false, reason: `read-only review: tool ${toolName} is not allowed` }
}

export function makeReviewCanUseTool(mcpAllow: string[]): CanUseTool {
  return async (toolName, input) => {
    const v = reviewVerdict(toolName, input, mcpAllow)
    if (v.ok) return { behavior: 'allow', updatedInput: input }
    return { behavior: 'deny', message: `Denied by PR Cockpit security policy — ${v.reason}`, interrupt: false }
  }
}

// Layer 1: a hook decision beats every permission rule; anything not denied here still goes through layers 2 and 3.
export function makeReviewGuardHook(mcpAllow: string[]): HookCallback {
  return async (input) => {
    if ((input as any)?.hook_event_name !== 'PreToolUse') return {}
    const toolName = String((input as any).tool_name ?? '')
    const v = reviewVerdict(toolName, (input as any).tool_input, mcpAllow)
    if (v.ok) return {}
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `PR Cockpit read-only guard — ${v.reason}` } }
  }
}

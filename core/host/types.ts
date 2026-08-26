import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import type { ProviderUsage } from '../runs/types'

// The session host's normalized event stream. Every provider (Claude SDK today, Codex app-server later) maps its
// native messages onto these; the UI, the recorder and the pipelines only ever see RunEvents.
export type RunEvent =
  | { t: 'init'; sessionId: string; model: string; permissionMode: PermissionMode; slashCommands: string[]; skills: string[]; mcpServers: { name: string; status: string }[]; tools: string[]; claudeCodeVersion: string }
  | { t: 'text_delta'; text: string; parent: string | null } // live only, never persisted
  | { t: 'assistant_text'; text: string; uuid: string; parent: string | null }
  | { t: 'thinking'; text: string; parent: string | null }
  | { t: 'tool_use'; id: string; name: string; input: unknown; parent: string | null }
  | { t: 'tool_result'; id: string; output: string; isError: boolean; parent: string | null }
  | { t: 'tool_progress'; id: string; name: string; elapsedSeconds: number; parent: string | null } // live only
  | { t: 'task'; status: 'started' | 'completed' | 'failed' | 'stopped'; taskId: string; summary?: string; description?: string }
  | { t: 'compaction'; trigger: 'manual' | 'auto'; preTokens: number; postTokens?: number }
  | { t: 'context'; totalTokens: number; maxTokens: number; percentage: number }
  | { t: 'permission_request'; promptId: string; kind: PromptKind; toolName: string; input: unknown; title?: string; description?: string; suggestions?: unknown }
  | { t: 'permission_resolved'; promptId: string; status: 'allowed' | 'denied' | 'answered' | 'expired' | 'cancelled' }
  | { t: 'permission_denied'; toolName: string; message: string }
  | { t: 'mode'; permissionMode: PermissionMode }
  | { t: 'status'; status: 'busy' | 'idle' | 'compacting' | 'waiting_prompt' | 'closed' }
  | { t: 'local_command'; content: string }
  | { t: 'reset'; sessionId: string | null } // the CLI cleared the conversation (/clear): new transcript, cost baseline resets
  | { t: 'turn_done'; subtype: string; isError: boolean; resultText: string; costUsd: number | null; durationMs: number; numTurns: number; usage: ProviderUsage | null }
  | { t: 'error'; message: string }

export type PromptKind = 'tool' | 'question' | 'plan'

// What the UI sends back for a pending permission_requests row.
export type PromptAnswer =
  | { behavior: 'allow'; always?: boolean; message?: string }
  | { behavior: 'deny'; message?: string }
  | { behavior: 'answer'; answers: Record<string, string | string[]>; message?: string } // AskUserQuestion

export type RunSpec = {
  runId: string
  kind: 'session' | 'probe'
  cwd: string
  model?: string
  effort?: string
  resume?: string | null // native claude session id to resume
  permissionMode?: PermissionMode
  allowDanger?: boolean // let dangerous Bash commands run without a prompt (live-read on every call)
  systemAppend?: string
  chrome?: boolean // pass --chrome so the Claude in Chrome MCP connects
  projectDirName?: string // CLAUDE_CODE_PROJECT_DIR_NAME (unifies memory across worktrees)
  db?: any
  schema?: any
}

// Live-only conveniences the pipeline wants per turn.
export type TurnCallbacks = {
  onText?: (delta: string) => void
  onTool?: (name: string, info: string) => void
  onSessionId?: (sessionId: string) => void
  onEvent?: (e: RunEvent) => void
}

export type TurnResult = { text: string; sessionId: string | null; usage: ProviderUsage | null; costUsd: number | null; subtype: string; isError: boolean; interrupted: boolean
  error?: string // API/runtime error text of a failed turn (the streamed text stays in `text`)
}

export function persistedEvent(e: RunEvent): boolean {
  return e.t !== 'text_delta' && e.t !== 'tool_progress'
}

// Short log line for an event (what the legacy log panel shows).
export function eventMessage(e: RunEvent): string | null {
  switch (e.t) {
    case 'tool_use': {
      const i = (e.input ?? {}) as Record<string, unknown>
      const v = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.description ?? i.prompt ?? ''
      return `${e.name} ${String(v).slice(0, 160)}`
    }
    case 'tool_result': return `↳ ${e.isError ? 'error' : 'ok'} ${e.output.slice(0, 160).replace(/\s+/g, ' ')}`
    case 'permission_request': return `permission? ${e.toolName}`
    case 'permission_resolved': return `permission ${e.status}`
    case 'permission_denied': return `denied ${e.toolName}: ${e.message.slice(0, 120)}`
    case 'compaction': return `compacted ${e.preTokens}→${e.postTokens ?? '?'} tokens (${e.trigger})`
    case 'context': return `context ${e.percentage}% (${e.totalTokens}/${e.maxTokens})`
    case 'task': return `subagent ${e.status}${e.summary ? `: ${e.summary.slice(0, 120)}` : ''}`
    case 'turn_done': return `turn ${e.subtype}${e.costUsd != null ? ` · $${e.costUsd.toFixed(3)}` : ''}`
    case 'error': return e.message
    case 'mode': return `mode ${e.permissionMode}`
    case 'init': return `session ${e.model} · ${e.permissionMode} · ${e.slashCommands.length} commands`
    case 'local_command': return e.content.slice(0, 160)
    case 'reset': return 'conversation cleared'
    default: return null
  }
}

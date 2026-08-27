export type CodexFailureKind = 'auth' | 'json' | 'invalid_thread' | 'interrupted' | 'runtime'
export type CodexPhase = 'review' | 'chat'

export function extractCodexErrorMessage(message: string): string {
  try {
    const parsed = JSON.parse(message) as { error?: { message?: string; type?: string; param?: string }; status?: number }
    if (parsed.error?.message) {
      const parts = [parsed.error.message]
      if (parsed.error.type) parts.push(`type=${parsed.error.type}`)
      if (parsed.error.param) parts.push(`param=${parsed.error.param}`)
      if (parsed.status) parts.push(`status=${parsed.status}`)
      return parts.join(' ')
    }
  } catch {
    /* not a structured Codex error */
  }
  return message
}

export function rawCodexErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return extractCodexErrorMessage(message)
}

export function previewRawOutput(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, 240)
}

export function classifyCodexError(error: unknown): CodexFailureKind {
  const message = rawCodexErrorMessage(error)
  if (/abort|aborted|cancel|cancelled|interrupted|SIGINT|SIGTERM|signal/i.test(message)) return 'interrupted'
  // Codex's wording: resuming a thread id whose rollout (session file) is missing locally → treat the thread as stale and retry with a new one.
  if (/no session|session .*not found|thread .*not found|conversation .*not found|resume.*not found|invalid.*thread|invalid.*session|codex.*sessions|no rollout|rollout .*not found|thread\/resume/i.test(message)) return 'invalid_thread'
  if (/auth|api[_ -]?key|unauthorized|forbidden|401|403|login|oauth/i.test(message)) return 'auth'
  if (/json|schema|parse|unexpected token/i.test(message)) return 'json'
  return 'runtime'
}

// A saved thread id whose rollout is gone locally: start a fresh thread instead of failing the turn.
export function shouldRetryCodexChatWithoutThread(error: unknown, hadSessionId: boolean): boolean {
  return hadSessionId && classifyCodexError(error) === 'invalid_thread'
}

export function formatCodexProviderError(phase: CodexPhase, error: unknown): string {
  const message = rawCodexErrorMessage(error)
  switch (classifyCodexError(error)) {
    case 'auth':
      return `Codex SDK authentication failed during ${phase}. Check OPENAI_API_KEY or local Codex login. Original error: ${message}`
    case 'invalid_thread':
      return `Codex ${phase} thread could not be resumed. The saved thread id may be stale or missing locally; start a new turn to create a fresh thread. Original error: ${message}`
    case 'interrupted':
      return `Codex ${phase} was interrupted before completion. Retry the task; any persisted draft state was left unchanged unless the pipeline recorded partial chat text. Original error: ${message}`
    case 'json':
      return `Codex ${phase} returned unusable JSON. ${message}`
    case 'runtime':
    default:
      return `Codex SDK ${phase} failed at runtime: ${message}`
  }
}

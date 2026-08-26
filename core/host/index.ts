import { claudeHost } from './claudeHost'
import { codexHost } from '../codex/codexHost'
import type { SessionHost } from './types'

// Provider → host. Pipelines know the provider of the turn they are about to run (hostFor); the /api/runs endpoints
// only know the run id and ask whichever host currently holds it live (hostOf) — a run is never live on both.
export function hostFor(provider: 'claude' | 'codex' | undefined): SessionHost {
  return provider === 'codex' ? codexHost : claudeHost
}

export function hostOf(runId: string): SessionHost {
  return codexHost.status(runId) !== 'closed' ? codexHost : claudeHost
}

export { claudeHost, codexHost }

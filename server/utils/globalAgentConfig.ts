import { eq } from 'drizzle-orm'
import { schema } from '~core/db/client'
import type { ReviewProvider } from '~core/agent/runners'

type RuntimeAgentConfig = unknown

export type GlobalAgentDefaults = {
  provider: ReviewProvider
  model: string
  effort?: string
  codexServiceTier?: string | null
}

function readConfig(cfg: RuntimeAgentConfig, key: string): unknown {
  return cfg && typeof cfg === 'object' ? (cfg as Record<string, unknown>)[key] : undefined
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function runtimeGlobalAgentDefaults(cfg: RuntimeAgentConfig, provider?: ReviewProvider): GlobalAgentDefaults {
  const p = provider ?? (readConfig(cfg, 'inferenceProvider') === 'codex' ? 'codex' : 'claude')
  return {
    provider: p,
    model: p === 'codex' ? str(readConfig(cfg, 'codexModel')) : str(readConfig(cfg, 'anthropicModel')),
    effort: str(readConfig(cfg, 'globalEffort')) || undefined,
    codexServiceTier: null,
  }
}

export function projectGlobalAgentDefaults(project: any, cfg: RuntimeAgentConfig): GlobalAgentDefaults {
  const provider: ReviewProvider = project?.provider === 'codex' ? 'codex' : 'claude'
  return {
    provider,
    model: provider === 'codex'
      ? (project?.model || str(readConfig(cfg, 'codexModel')))
      : (project?.model || str(readConfig(cfg, 'anthropicModel'))),
    effort: project?.effort || undefined,
    codexServiceTier: provider === 'codex' && project?.codexServiceTier === 'fast' ? 'fast' : null,
  }
}

export function resolveGlobalAgentDefaults(d: any, cfg: RuntimeAgentConfig, projectId?: string | null): GlobalAgentDefaults {
  const id = projectId?.trim()
  if (id) {
    const project = d.select().from(schema.projects).where(eq(schema.projects.id, id)).get()
    if (project) return projectGlobalAgentDefaults(project, cfg)
  }
  return runtimeGlobalAgentDefaults(cfg)
}

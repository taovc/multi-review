import { eq } from 'drizzle-orm'
import { schema } from '~core/db/client'
import type { ReviewProvider } from '~core/agent/runners'
import { loadMethodology } from '~core/methodology'

// Resolve a project's review config: methodology (active skill wins), provider, model, effort.
// Key constraint, "never mix": every stage runs on the same provider, and model is always "the real
// model of the current provider".
// - claude projects: model = project.model || ANTHROPIC_MODEL (used for first review / recheck /
//   feedback recheck / Skill / chat alike)
// - codex projects: model = project.model || CODEX_MODEL (empty = the Codex SDK default)
// translateModel (the mechanical translation when posting comments): claude uses the fast model
// TRANSLATE_MODEL; codex still uses the main codex model (no mixing).
export function resolveReviewConfig(d: any, project: any) {
  const cfg = useRuntimeConfig()
  const provider: ReviewProvider = project.provider === 'codex' ? 'codex' : 'claude'
  let methodology: string
  if (project.activeSkillId) {
    const skill = d.select().from(schema.skills).where(eq(schema.skills.id, project.activeSkillId)).get()
    methodology = skill?.content || loadMethodology(project)
  } else {
    methodology = loadMethodology(project)
  }
  const model =
    provider === 'codex'
      ? ((project.model || cfg.codexModel || '') as string)
      : ((project.model || cfg.anthropicModel) as string)
  const translateModel = provider === 'codex' ? model : (cfg.translateModel as string)
  const codexServiceTier = provider === 'codex' && project.codexServiceTier === 'fast' ? 'fast' : null
  return {
    methodology,
    provider,
    model,
    translateModel,
    effort: (project.effort || '') as string,
    codexServiceTier,
  }
}

import { withContract } from './guard'
import { runCodexReadonly } from './codexAgent'
import { normalizeCodexReviewError } from './codexReview'
import { SKILL_SYSTEM, buildSkillPrompt, cleanSkillContent, type SkillGenOptions } from './skillgen'

// Codex version of skill generation: read-only pass over the local project, producing methodology markdown.
// Codex has no systemPrompt field → fold the operating contract + SYSTEM into the start of the prompt.
export async function generateSkillCodex(opts: SkillGenOptions): Promise<{ content: string; costUsd: number }> {
  try {
    const prompt = `${withContract(SKILL_SYSTEM)}\n\n---\n\n${buildSkillPrompt(opts)}`
    const raw = await runCodexReadonly({
      prompt,
      cwd: opts.cwd,
      model: opts.model,
      effort: opts.effort,
      serviceTier: opts.codexServiceTier,
      label: 'skill generation',
      onTool: opts.onTool,
    })
    return { content: cleanSkillContent(raw), costUsd: 0 }
  } catch (error) {
    throw normalizeCodexReviewError(error)
  }
}

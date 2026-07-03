import { withContract } from './guard'
import { runCodexReadonly } from './codexAgent'
import { normalizeCodexReviewError } from './codexReview'
import { SKILL_SYSTEM, buildSkillPrompt, cleanSkillContent, type SkillGenOptions } from './skillgen'

// Codex 版 Skill 生成：read-only 读本地项目产出方法学 markdown。
// Codex 没有 systemPrompt 字段 → 把操作契约 + SYSTEM 折进 prompt 开头。
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

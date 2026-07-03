import { eq } from 'drizzle-orm'
import { schema } from '~core/db/client'
import type { ReviewProvider } from '~core/agent/runners'
import { loadMethodology } from '~core/methodology'

// 解析一个项目的审核配置：方法学(active skill 优先)、provider、模型、effort。
// 关键约束「不混用」：所有阶段都用同一个 provider 跑，model 就是「当前 provider 的实模型」。
// - claude 项目：model = project.model || ANTHROPIC_MODEL（首审/复审/反馈复审/Skill/聊天全用它）
// - codex 项目：model = project.model || CODEX_MODEL（空=Codex SDK 默认）
// translateModel（发评论的机械翻译）：claude 用快模型 TRANSLATE_MODEL；codex 仍用 codex 主模型（不混用）。
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

import { nanoid } from 'nanoid'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { schema } from '~core/db/client'
import { generateSkill } from '~core/agent/skillgen'
import { generateSkillCodex } from '~core/agent/codexSkill'
import { resolveLang, type LangCode } from '~core/agent/lang'
import { cockpitBus } from '~core/events'

// AI 读本地项目生成/赋能审核 skill。结果存为**新候选**(不激活、不覆盖)，返回新 skill 供预览/对比。
const Body = z.object({
  baseSkillId: z.string().optional(),
  name: z.string().optional(),
  instruction: z.string().optional(), // 用户自定义指令（介入生成方向）
})

// 用户可见文案（错误 / 进度 / 候选标签）跟 UI locale 走（mr-locale），与技能正文同语言。缺省 zh。
type SkillGenMessages = {
  notFound: string
  noLocalPath: string
  defaultModel: string
  stage: (provider: string, model: string, effort: string) => string
  done: (ops: number, costUsd: string) => string
  label: (optimize: boolean, stamp: string) => string
}
const SKILLGEN_MESSAGES = {
  zh: {
    notFound: '项目不存在',
    noLocalPath: '项目未配置本地 clone 路径（生成需要读代码）',
    defaultModel: '默认',
    stage: (p, m, e) => `开始调研项目（${p} · ${m}${e}）…`,
    done: (n, cost) => `生成完成 · 读取/搜索 ${n} 次 · $${cost}`,
    label: (o, s) => `${o ? 'AI 优化' : 'AI 生成'} · ${s}`,
  },
  en: {
    notFound: 'Project not found',
    noLocalPath: 'Project has no local clone path configured (generation needs to read the code)',
    defaultModel: 'default',
    stage: (p, m, e) => `Researching project (${p} · ${m}${e})…`,
    done: (n, cost) => `Generation complete · ${n} read/search ops · $${cost}`,
    label: (o, s) => `${o ? 'AI · Optimized' : 'AI · Generated'} · ${s}`,
  },
  fr: {
    notFound: 'Projet introuvable',
    noLocalPath: 'Le projet n’a pas de chemin de clone local configuré (la génération doit lire le code)',
    defaultModel: 'par défaut',
    stage: (p, m, e) => `Analyse du projet en cours (${p} · ${m}${e})…`,
    done: (n, cost) => `Génération terminée · ${n} lectures/recherches · $${cost}`,
    label: (o, s) => `${o ? 'IA · Optimisé' : 'IA · Généré'} · ${s}`,
  },
} satisfies Record<LangCode, SkillGenMessages>

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const b = Body.parse((await readBody(event)) || {})
  const d = db()
  // 产出语言跟 UI locale 走（与其它 AI 端点一致：reviews/features/fix）；缺省 zh。
  // 归一化只做一次，技能正文和这些用户可见文案共用同一个结果，不会出现一边英文一边中文。
  const lang = resolveLang(getCookie(event, 'mr-locale'))
  const t: SkillGenMessages = SKILLGEN_MESSAGES[lang]

  const project = d.select().from(schema.projects).where(eq(schema.projects.id, id)).get()
  if (!project) throw createError({ statusCode: 404, statusMessage: t.notFound })
  if (!project.localPath) throw createError({ statusCode: 400, statusMessage: t.noLocalPath })

  let baseContent: string | null = null
  if (b.baseSkillId) {
    const base = d.select().from(schema.skills).where(eq(schema.skills.id, b.baseSkillId)).get()
    baseContent = base?.content ?? null
  }

  // 走项目配置的 model + effort（与审核引擎一致）
  const rc = resolveReviewConfig(d, project)
  // 进度事件用项目级 key 推到事件总线，前端开 SSE 监听（见 genstream.get.ts）
  const key = `skillgen:${id}`
  const emit = (kind: string, message: string) =>
    cockpitBus.emit({ reviewId: key, ts: new Date().toISOString(), kind, message })

  let content: string
  let toolN = 0
  // 跟随项目 provider（不混用）：codex 项目用 Codex 读项目生成方法学，claude 项目用 Claude。
  const runGenerate = rc.provider === 'codex' ? generateSkillCodex : generateSkill
  try {
    emit('stage', t.stage(rc.provider, rc.model || t.defaultModel, rc.effort ? ' · ' + rc.effort : ''))
    const res = await runGenerate({
      cwd: project.localPath,
      model: rc.model,
      effort: rc.effort,
      codexServiceTier: rc.codexServiceTier,
      baseContent,
      instruction: b.instruction || null,
      lang,
      onTool: (name, info) => emit('tool', `[${++toolN}] ${name} ${info}`),
    })
    content = res.content
    emit('done', t.done(toolN, res.costUsd.toFixed(3)))
  } catch (e) {
    emit('error', (e as Error).message)
    throw createError({ statusCode: 502, statusMessage: (e as Error).message })
  }

  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ')
  const row = {
    id: nanoid(),
    projectId: id,
    name: b.name || t.label(!!baseContent, stamp),
    content,
    source: (baseContent ? 'optimized' : 'ai') as 'optimized' | 'ai',
    createdAt: new Date().toISOString(),
  }
  d.insert(schema.skills).values(row).run()
  return row // 不激活；前端做 diff 预览后由用户决定激活
})

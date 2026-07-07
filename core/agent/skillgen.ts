import { query } from '@anthropic-ai/claude-agent-sdk'
import { withContract, reviewCanUseTool, ISOLATED } from './guard'
import { langName } from './lang'

export const SKILL_SYSTEM = `你是一名资深架构师 + 代码审核负责人。你的任务是为一个具体项目量身定制一套"代码审核方法学"（review skill），供后续 AI 审核该项目的 PR 时作为 system prompt 使用。`
const SYSTEM = SKILL_SYSTEM

// Multi Review 的运行边界：生成的 skill 必须只写"审核准则"，不能写"操作流程"。
export const SKILL_BOUNDARY = `【Multi Review 边界 · 生成 skill 时必须遵守】
你产出的方法学，将来会被一个**只读、在隔离 worktree 里、绝不做 git 写、只审不改**的审核 agent 当作准则。因此：
- ✅ 只写"审什么、怎么判"：检查项、严重度判断、该项目特有的架构/约定关注点。
- ❌ 绝不写任何"操作流程"：不要写 commit/push/git 任何写操作、不要写"创建/跳过 worktree"、不要写"修复 bug/顺手改"、不要写"发评论/合并"。这些由 Multi Review 引擎统一控制，写进 skill 也会被忽略和拦截，只会污染方法学。`
const BOUNDARY = SKILL_BOUNDARY

export type SkillGenOptions = {
  cwd: string
  model: string
  effort?: string
  codexServiceTier?: string | null
  baseContent?: string | null
  instruction?: string | null // 用户自定义指令（介入生成方向）
  lang?: string | null // 产出语言（跟 UI locale 走）；缺省 zh
  onTool?: (name: string, info: string) => void
}

// 用户侧 prompt（不含 SYSTEM）：Claude 把 SYSTEM 当 systemPrompt 传；Codex 没有 systemPrompt 字段，需把 SYSTEM 折进 prompt。
export function buildSkillPrompt(opts: Pick<SkillGenOptions, 'baseContent' | 'instruction' | 'lang'>): string {
  const base = opts.baseContent?.trim()
  const task = base
    ? `下面是这个项目"当前"的审核方法学。请结合你对仓库的实际理解**优化**它：保留有用的，补齐缺口，纠正过时/不准确的地方，让它更贴合这个项目的真实架构与约定。\n\n--- 当前方法学 ---\n${base}\n--- 结束 ---`
    : `这个项目还没有审核方法学，请从零生成一套。`

  const userInstruction = opts.instruction?.trim()
    ? `\n【审核员的特别要求（最高优先级，务必满足）】\n${opts.instruction.trim()}\n`
    : ''

  return `${task}
${userInstruction}
**先完整、深入地调研仓库**（当前目录就是项目根），不要浅尝辄止：
- 通读 README、CLAUDE.md、AGENTS.md、docs/、memory-vault/ 等所有文档
- 读 package.json / 目录结构判断技术栈与分层，必要时进子目录看真实代码
- grep 出关键约定：状态管理、权限模型、API/tRPC 层、数据库/ORM、构建期分支(#if 等)、测试约定、文件组织规范
- 对拿不准的约定，多读几个真实文件确认，而不是猜

调研要充分（宁可多读多 grep），想清楚再写。然后产出一套**面向本项目的审核方法学**：
- 用${langName(opts.lang)}撰写整套方法学（所有标题、正文、检查项都用这门语言；专有名词/代码标识符保留原文）
- 包含：横向影响检查、该项目特有的架构/约定专项检查（按你调研到的实际情况，不要套用无关技术栈）、安全/权限、测试、风险点
- 具体、可执行，引用真实的目录/文件/标识符约定
- 不要泛泛而谈
${userInstruction ? '- 务必体现上面审核员的特别要求' : ''}

只读操作（读文件、grep、ls）。❌ 不做任何写操作。

${BOUNDARY}

最后**只输出方法学正文本身**：以一个 markdown 标题（如 \`# ...\`）开头，不要代码围栏包裹，**不要任何思考过程/旁白**（如 "Let me..."、"Now I..."、"这是方法学："），不要前后缀说明。第一个字符就是正文标题。`
}

// 清洗产出：剥掉代码围栏 + 开头旁白（从第一个 markdown 标题开始）。
export function cleanSkillContent(text: string): string {
  let content = text.trim().replace(/^```(?:markdown|md)?\s*/i, '').replace(/```\s*$/i, '').trim()
  const h = content.search(/^#{1,3}\s/m)
  if (h > 0) content = content.slice(h).trim()
  if (!content) throw new Error('生成结果为空')
  return content
}

// 让 agent 读本地项目，产出/优化一套审核方法学（markdown 正文）。
export async function generateSkill(opts: SkillGenOptions): Promise<{ content: string; costUsd: number }> {
  const prompt = buildSkillPrompt(opts)
  const stream = query({
    prompt,
    options: {
      model: opts.model,
      // effort：项目配置；为空时默认 high，保证"深度思考"
      effort: (opts.effort || 'high') as any,
      systemPrompt: withContract(SYSTEM),
      cwd: opts.cwd,
      allowedTools: ['Read', 'Grep', 'Glob'],
      canUseTool: reviewCanUseTool,
      ...ISOLATED,
      maxTurns: 80,
    },
  })
  let text = ''
  let costUsd = 0
  for await (const msg of stream) {
    if (msg.type === 'assistant') {
      const content = (msg as any).message?.content
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b.type === 'text') text += b.text
          else if (b.type === 'tool_use') opts.onTool?.(b.name, String(b.input?.command || b.input?.pattern || b.input?.file_path || '').slice(0, 80))
        }
      }
    } else if (msg.type === 'result') {
      const c = (msg as any).total_cost_usd
      if (typeof c === 'number') costUsd += c
    }
  }
  return { content: cleanSkillContent(text), costUsd }
}

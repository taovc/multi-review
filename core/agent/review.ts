import { query } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { withContract, reviewCanUseTool, ISOLATED } from './guard'
import { salvageJson } from './jsonSalvage'
import { outputLangClause } from './lang'

export const FindingSchema = z.object({
  severity: z.enum(['High', 'Medium', 'Low']),
  title: z.string(),
  location: z.string().default(''),
  problem: z.string().default(''),
  detail: z.string().default(''),
  fix: z.string().default(''),
  introducedByPr: z.boolean().default(true),
})
export const ReviewResultSchema = z.object({
  findings: z.array(FindingSchema).default([]),
  logic: z.string().default(''),
  quality: z.string().default(''),
  risk: z.string().default(''),
  conclusion: z.string().default(''),
  requirement: z.string().default(''),
  testPath: z.string().default(''),
})
export type ReviewResult = z.infer<typeof ReviewResultSchema>

// 输出语言跟 UI locale 走（#16「工作语言」），不再硬编码中文
const outputSpec = (lang: string) => `审完后，最后**只输出一个 JSON 对象**（不要 markdown 代码围栏、不要任何额外文字），结构：
{
  "findings": [
    { "severity": "High|Medium|Low", "title": "一句话标题", "location": "path:line",
      "problem": "为什么是问题", "detail": "详情(可含要点)", "fix": "修复方向",
      "introducedByPr": true }
  ],
  "logic": "需求/逻辑核对",
  "quality": "代码质量/复用",
  "risk": "风险",
  "conclusion": "能不能合 + blocking 是什么",
  "requirement": "这条 PR 在做什么业务诉求(用业务语言)",
  "testPath": "用户视角的最短手动测试路径 + 回归点"
}
findings 按严重度 High→Medium→Low 排序。${outputLangClause(lang)}
requirement / testPath 用**真实换行**分行（JSON 字符串里用 \\n），每个步骤/要点单独一行，分节（正向 / 负向·边界 / 回归点）各自起新行，不要挤成一大段流水。

⚠️ 输出**严格合法 JSON**：字符串值内**绝不要出现未转义的英文双引号 \`"\`**（这会截断 JSON）。需要引用代码/文案时，一律用「」或反引号 \`，不要用英文双引号。代码片段也放进反引号里。`

export function buildReviewPrompt(opts: { repo: string; prNumber: number; branch: string; defaultBranch: string; lang: string }) {
  const { repo, prNumber, branch, defaultBranch } = opts
  return `你在一个 git worktree 里（当前目录就是仓库，已 checkout PR #${prNumber} 的分支 ${branch} 并合并了 ${defaultBranch}）。

审核仓库 ${repo} 的 PR #${prNumber}。

步骤：
1. 看变更：\`git diff origin/${defaultBranch}...HEAD\`、\`git log origin/${defaultBranch}..HEAD --oneline\`
2. 需要时读相关文件、grep 调用点（被改的导出名要在全仓 grep 找谁在用）
3. 读 PR 描述与历史评论辅助理解：\`gh pr view ${prNumber} --repo ${repo} --json title,body,comments,reviews\`
4. 按方法学（见 system prompt）审核

纪律（强制）：
- 只读操作：git diff/log/show、grep、读文件、gh pr view。
- ❌ 绝对禁止 git add/commit/push/checkout 新分支/reset，禁止任何写操作。

${outputSpec(opts.lang)}`
}

export type ReviewAgentOptions = {
  cwd: string
  repo: string
  prNumber: number
  branch: string
  defaultBranch: string
  methodology: string
  model: string
  effort?: string
  codexServiceTier?: string | null
  lang?: string
  onTool?: (name: string, info: string) => void
}

// 跑一次审核：Agent SDK 带 git 工具在 worktree 里干活，返回结构化结果。
export async function runReviewAgent(opts: ReviewAgentOptions): Promise<{ result: ReviewResult; costUsd: number; raw: string }> {
  const stream = query({
    prompt: buildReviewPrompt({ ...opts, lang: opts.lang || 'zh' }),
    options: {
      model: opts.model,
      ...(opts.effort ? { effort: opts.effort as any } : {}),
      systemPrompt: withContract(opts.methodology),
      cwd: opts.cwd,
      allowedTools: ['Read', 'Grep', 'Glob'],
      canUseTool: reviewCanUseTool,
      ...ISOLATED,
      maxTurns: 60,
    },
  })

  let text = ''
  let costUsd = 0
  for await (const msg of stream) {
    if (msg.type === 'assistant') {
      const content = (msg as any).message?.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text') text += block.text
          else if (block.type === 'tool_use') {
            const info =
              typeof block.input?.command === 'string'
                ? block.input.command
                : block.input?.pattern || block.input?.file_path || ''
            opts.onTool?.(block.name, String(info).slice(0, 80))
          }
        }
      }
    } else if (msg.type === 'result') {
      const c = (msg as any).total_cost_usd
      if (typeof c === 'number') costUsd += c
    }
  }

  const parsed = ReviewResultSchema.parse(await salvageJson(text, opts.model))
  return { result: parsed, costUsd, raw: text }
}

// ── 带反馈的针对性复审（guided）──
export const GuidedFindingSchema = z.object({
  fid: z.string().optional(), // 命中已有 finding 则带上；新发现不带
  severity: z.enum(['High', 'Medium', 'Low']),
  title: z.string(),
  location: z.string().default(''),
  problem: z.string().default(''),
  detail: z.string().default(''),
  fix: z.string().default(''),
  introducedByPr: z.boolean().default(true),
  response: z
    .object({
      status: z.enum(['kept', 'retracted', 'adjusted', 'discuss', 'new']),
      text: z.string().default(''),
    })
    .optional(),
})
export const GuidedResultSchema = z.object({
  findings: z.array(GuidedFindingSchema).default([]),
  logic: z.string().default(''),
  quality: z.string().default(''),
  risk: z.string().default(''),
  conclusion: z.string().default(''),
  requirement: z.string().default(''),
  testPath: z.string().default(''),
})
export type GuidedResult = z.infer<typeof GuidedResultSchema>

export type GuidedInput = { fid: string; severity: string; title: string; location: string | null; problem: string | null; reviewerNote: string | null }

export type GuidedReviewAgentOptions = {
  cwd: string
  repo: string
  prNumber: number
  branch: string
  defaultBranch: string
  methodology: string
  model: string
  effort?: string
  codexServiceTier?: string | null
  lang?: string
  existing: GuidedInput[]
  instruction: string
  globalNotes: string
  onTool?: (name: string, info: string) => void
}

export function buildGuidedReviewPrompt(opts: GuidedReviewAgentOptions): string {
  return `你在一个 git worktree 里（已 checkout PR #${opts.prNumber} 分支 ${opts.branch} 并合并 ${opts.defaultBranch}）。这是一次**带审核员反馈的针对性复审**，不是从零重审。

审核员对上一轮的反馈：
- 审核指令（重点看这里，针对性审我提到的内容）：${opts.instruction || '（无）'}
- 整体说明：${opts.globalNotes || '（无）'}

上一轮的 findings（reviewerNote 是审核员对该条的回复/质疑/补充）：
${JSON.stringify(opts.existing, null, 2)}

步骤：
1. 看变更：git diff origin/${opts.defaultBranch}...HEAD；需要时读文件 / grep
2. 针对审核员指令做重点核查
3. 对每条已有 finding，结合 reviewerNote 给回应：
   - kept：维持原判（说明理由）
   - retracted：撤回（审核员说得对 / 我之前判断有误，说明为什么撤）
   - adjusted：调整（改严重度或措辞，说明怎么改）
   - discuss：你也不确定，想和审核员讨论（提出具体问题）
   每条已有 finding 必须带上原 fid 和 response。
4. 若审核员指令引出**新问题**，新增 finding（不带 fid，response.status="new"）。

纪律：只读（git diff/log/show、grep、读文件、gh pr view）。❌ 禁止任何 git 写操作。

最后**只输出 JSON**（无代码围栏）：
{ "findings": [ { "fid": "F1"(已有则带), "severity": "...", "title": "...", "location": "path:line",
   "problem": "...", "detail": "...", "fix": "...", "introducedByPr": true,
   "response": { "status": "kept|retracted|adjusted|discuss|new", "text": "<你对审核员的回应>" } } ],
  "logic": "...", "quality": "...", "risk": "...", "conclusion": "本轮复审整体结论",
  "requirement": "...", "testPath": "..." }

${outputLangClause(opts.lang || 'zh')}
⚠️ 严格合法 JSON：字符串里**绝不要未转义的英文双引号 \`"\`**，引用一律用「」或反引号 \`。`
}

export async function runGuidedReviewAgent(opts: GuidedReviewAgentOptions): Promise<{ result: GuidedResult; costUsd: number }> {
  const prompt = buildGuidedReviewPrompt(opts)
  const stream = query({
    prompt,
    options: {
      model: opts.model,
      ...(opts.effort ? { effort: opts.effort as any } : {}),
      systemPrompt: withContract(opts.methodology),
      cwd: opts.cwd,
      allowedTools: ['Read', 'Grep', 'Glob'],
      canUseTool: reviewCanUseTool,
      ...ISOLATED,
      maxTurns: 50,
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
  return { result: GuidedResultSchema.parse(await salvageJson(text, opts.model)), costUsd }
}

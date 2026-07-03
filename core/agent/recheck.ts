import { query } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { withContract, reviewCanUseTool, ISOLATED } from './guard'
import { salvageJson } from './jsonSalvage'
import { outputLangClause } from './lang'

export const RecheckSchema = z.object({
  rechecks: z
    .array(
      z.object({
        fid: z.string(),
        status: z.enum(['fixed', 'partial', 'unaddressed', 'replied', 'new']),
        text: z.string().default(''),
      }),
    )
    .default([]),
  // 作者在新 commit 里引入的新问题/回归 → 建成新 finding（带完整字段，不走 rechecks）
  newFindings: z
    .array(
      z.object({
        severity: z.enum(['High', 'Medium', 'Low']),
        title: z.string(),
        location: z.string().default(''),
        problem: z.string().default(''),
        detail: z.string().default(''),
        fix: z.string().default(''),
        text: z.string().default(''), // 在哪个 commit/行引入的说明
      }),
    )
    .default([]),
  // 复审后的整体结论（还剩哪些 blocking、现在能不能合）→ 覆盖首审的 AI 总评
  conclusion: z.string().default(''),
})
export type RecheckResult = z.infer<typeof RecheckSchema>

export type ExistingFinding = { fid: string; title: string; location: string | null; problem: string | null; fix: string | null; notes: string | null }

export type RecheckAgentOptions = {
  cwd: string
  repo: string
  prNumber: number
  defaultBranch: string
  lastPostSha: string | null
  requirement: string | null
  findings: ExistingFinding[]
  methodology: string
  model: string
  effort?: string
  codexServiceTier?: string | null
  lang?: string
  onTool?: (name: string, info: string) => void
}

export function buildRecheckPrompt(opts: RecheckAgentOptions): string {
  const baseline = opts.lastPostSha
    ? `上次发评论时的 commit 是 ${opts.lastPostSha}。先看 \`git diff ${opts.lastPostSha}..HEAD\` 和 \`git log ${opts.lastPostSha}..HEAD --oneline\`，这是作者在你评论之后改的东西。`
    : `没有记录上次评论的 commit，用 \`git diff origin/${opts.defaultBranch}...HEAD\` 看全部变更。`

  return `你在一个 git worktree 里（已 checkout 该 PR 最新分支并合并 ${opts.defaultBranch}）。复审 ${opts.repo} 的 PR #${opts.prNumber}。

背景需求（这个 PR 本来要做的事，判断"改对没"时对照它）：
${opts.requirement?.trim() || '（无记录）'}

${baseline}

读全部历史评论 + 你上轮发的行级评论 + 作者的回复再判断，别只看 diff：
- PR 对话与 review 概览：\`gh pr view ${opts.prNumber} --repo ${opts.repo} --json comments,reviews,commits\`
- 你发的行级 review 评论及作者逐条回复：\`gh api repos/${opts.repo}/pulls/${opts.prNumber}/comments\`

这是上一轮的 findings（带原始问题 problem 与建议修复 fix；逐条判断作者改了没）：
${JSON.stringify(opts.findings.map((f) => ({ fid: f.fid, title: f.title, location: f.location, problem: f.problem, suggestedFix: f.fix, reviewerNote: f.notes })), null, 2)}

对每条已有 finding 判断状态（每条都要给）：
- fixed：作者已按反馈改好（说明在哪个 commit/行改的）
- partial：改了一部分 / 改得不对
- unaddressed：没动
- replied：作者只在评论里回复、代码没改（核对回复是否成立）

另外**重点**：审作者这批新改动**本身有没有引入新问题/回归**——改 A 弄坏 B、漏改调用点、新逻辑有 bug、破坏既有行为等。发现的放进 newFindings（带完整字段 severity/title/location/problem/fix），**不要**塞进 rechecks；没有就给空数组。

最后给一个**复审后的整体结论** conclusion：综合这轮判断（哪些已修复、哪些还没、有没有新引入的问题），说清现在还剩哪些 blocking、现在能不能合了。这会替换页面上的「AI 总评」，按现状写，别照抄首审结论。

纪律：只读（git diff/log/show、grep、gh pr view）。❌ 禁止任何 git 写操作。

最后**只输出 JSON**（无代码围栏）：
{
  "rechecks": [ { "fid": "F1", "status": "fixed", "text": "说明，引用具体 commit/行" } ],
  "newFindings": [ { "severity": "High|Medium|Low", "title": "一句话标题", "location": "path:line",
    "problem": "为什么是问题", "detail": "详情", "fix": "修复方向", "text": "在哪个 commit/行引入" } ],
  "conclusion": "复审后的整体结论：还剩哪些 blocking、现在能不能合"
}

${outputLangClause(opts.lang || 'zh')}
⚠️ 严格合法 JSON：text/problem 等字段里**绝不要未转义的英文双引号 \`"\`**，引用一律用「」或反引号 \`。`
}

export async function runRecheckAgent(opts: RecheckAgentOptions): Promise<{ result: RecheckResult; costUsd: number }> {
  const prompt = buildRecheckPrompt(opts)
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
      maxTurns: 40,
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
          else if (b.type === 'tool_use') opts.onTool?.(b.name, String(b.input?.command || '').slice(0, 80))
        }
      }
    } else if (msg.type === 'result') {
      const c = (msg as any).total_cost_usd
      if (typeof c === 'number') costUsd += c
    }
  }
  const result = RecheckSchema.parse(await salvageJson(text, opts.model))
  return { result, costUsd }
}

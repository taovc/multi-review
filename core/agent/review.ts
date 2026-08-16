import { query } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { withContract, reviewCanUseTool, ISOLATED } from './guard'
import { salvageJson } from './jsonSalvage'
import { outputLangClause } from './lang'
import { REVIEW_SECTIONS } from './reviewSections'

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

// Output language follows the UI locale (#16 "working language"); no longer hardcoded to Chinese
const outputSpec = (lang: string) => `When you are done, output **only a single JSON object** (no markdown code fences, no extra text), shaped like this:
{
  "findings": [
    { "severity": "High|Medium|Low", "title": "one-line title", "location": "path:line",
      "problem": "why this is a problem", "detail": "details (may include bullet points)", "fix": "the direction of the fix",
      "introducedByPr": true }
  ],
  "logic": "requirement / logic check",
  "quality": "code quality / reuse",
  "risk": "risk",
  "conclusion": "mergeable or not + what is blocking",
  "requirement": "what business need this PR serves (in business language)",
  "testPath": "shortest manual test path from the user's point of view + regression points"
}
Sort findings by severity, High→Medium→Low. ${outputLangClause(lang)}
Break requirement / testPath onto **real newlines** (\\n inside the JSON string), one step/point per line, each section (${REVIEW_SECTIONS.join(', ')}) starting on its own line — do not cram everything into one run-on block.

⚠️ Output **strictly valid JSON**: **never emit an unescaped ASCII double quote \`"\` inside a string value** (it truncates the JSON). When you need to quote code or wording, always use 「」 or backticks \`, never ASCII double quotes. Put code snippets inside backticks too.`

export function buildReviewPrompt(opts: { repo: string; prNumber: number; branch: string; defaultBranch: string; lang: string }) {
  const { repo, prNumber, branch, defaultBranch } = opts
  return `You are inside a git worktree (the current directory is the repo, with PR #${prNumber}'s branch ${branch} checked out and ${defaultBranch} merged in).

Review PR #${prNumber} of repo ${repo}.

Steps:
1. Look at the changes: \`git diff origin/${defaultBranch}...HEAD\`, \`git log origin/${defaultBranch}..HEAD --oneline\`
2. Read the relevant files as needed and grep for call sites (for any changed exported name, grep the whole repo for who uses it)
3. Read the PR description and past comments for context: \`gh pr view ${prNumber} --repo ${repo} --json title,body,comments,reviews\`
4. Review according to the methodology (see system prompt)

Discipline (mandatory):
- Read-only operations: git diff/log/show, grep, reading files, gh pr view.
- ❌ Absolutely forbidden: git add / git commit / git push / git checkout of a new branch / git reset — any write operation whatsoever is forbidden.

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

// Run one review: the Agent SDK works inside the worktree with git tools and returns a structured result.
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

// ── Targeted re-review driven by reviewer feedback (guided) ──
export const GuidedFindingSchema = z.object({
  fid: z.string().optional(), // set when it maps to an existing finding; omitted for newly found ones
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
  return `You are inside a git worktree (PR #${opts.prNumber}'s branch ${opts.branch} is checked out with ${opts.defaultBranch} merged in). This is a **targeted re-review driven by reviewer feedback**, not a review from scratch.

The reviewer's feedback on the previous round:
- Review instruction (focus here — review specifically what I mention): ${opts.instruction || '(none)'}
- General notes: ${opts.globalNotes || '(none)'}

Findings from the previous round (reviewerNote is the reviewer's reply/challenge/addition for that item):
${JSON.stringify(opts.existing, null, 2)}

Steps:
1. Look at the changes: git diff origin/${opts.defaultBranch}...HEAD; read files / grep as needed
2. Focus your checks on the reviewer's instruction
3. For every existing finding, respond in light of its reviewerNote:
   - kept: stand by the original call (explain why)
   - retracted: withdraw it (the reviewer is right / I judged wrong before — explain why you withdraw)
   - adjusted: adjust it (change severity or wording — explain how)
   - discuss: you are unsure too and want to discuss with the reviewer (ask a concrete question)
   Every existing finding must carry its original fid and a response.
4. If the reviewer's instruction surfaces a **new problem**, add a new finding (no fid, response.status="new").

Discipline: read-only (git diff/log/show, grep, reading files, gh pr view). ❌ Any git write operation is forbidden.

At the end, output **JSON only** (no code fences):
{ "findings": [ { "fid": "F1" (include it when the finding already exists), "severity": "...", "title": "...", "location": "path:line",
   "problem": "...", "detail": "...", "fix": "...", "introducedByPr": true,
   "response": { "status": "kept|retracted|adjusted|discuss|new", "text": "<your response to the reviewer>" } } ],
  "logic": "...", "quality": "...", "risk": "...", "conclusion": "overall conclusion of this re-review round",
  "requirement": "...", "testPath": "..." }

${outputLangClause(opts.lang || 'zh')}
⚠️ Strictly valid JSON: **never leave an unescaped ASCII double quote \`"\`** inside a string; always quote with 「」 or backticks \`.`
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

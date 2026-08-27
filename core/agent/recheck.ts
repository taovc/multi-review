import { query } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { withContract } from './guard'
import { buildReviewOptions } from '../host/options'
import type { ReviewHostOptions } from './review'
import { jsonSchemaFor, parseStructured } from './structured'
import { outputLangClause, resolveLang } from './lang'
import { usageFromClaudeResult } from './usage'
import type { ProviderUsage } from '../runs/types'

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
  // New problems/regressions the author introduced in the new commits → become new findings
  // (full fields, not routed through rechecks)
  newFindings: z
    .array(
      z.object({
        severity: z.enum(['High', 'Medium', 'Low']),
        title: z.string(),
        location: z.string().default(''),
        problem: z.string().default(''),
        detail: z.string().default(''),
        fix: z.string().default(''),
        text: z.string().default(''), // note on which commit/line introduced it
      }),
    )
    .default([]),
  // Overall verdict after the recheck (which blockers remain, is it mergeable now)
  // → overwrites the AI verdict from the first review
  conclusion: z.string().default(''),
})
export type RecheckResult = z.infer<typeof RecheckSchema>
const RECHECK_JSON_SCHEMA = jsonSchemaFor(RecheckSchema)

export type ExistingFinding = { fid: string; title: string; location: string | null; problem: string | null; fix: string | null; notes: string | null }

export type RecheckAgentOptions = ReviewHostOptions & {
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
    ? `The commit at the time of your last comment was ${opts.lastPostSha}. Start with \`git diff ${opts.lastPostSha}..HEAD\` and \`git log ${opts.lastPostSha}..HEAD --oneline\` — that is what the author changed after your comment.`
    : `There is no record of the commit from the last comment; use \`git diff origin/${opts.defaultBranch}...HEAD\` to see all the changes.`

  return `You are inside a git worktree (the PR's latest branch is checked out and ${opts.defaultBranch} is merged in). Re-review PR #${opts.prNumber} of ${opts.repo}.

Background requirement (what this PR was supposed to do — check "did they fix it correctly" against this):
${opts.requirement?.trim() || '(not recorded)'}

${baseline}

Read all the historical comments + the line-level comments you posted last round + the author's replies before judging; do not go by the diff alone:
- PR conversation and review overview: \`gh pr view ${opts.prNumber} --repo ${opts.repo} --json comments,reviews,commits\`
- The line-level review comments you posted and the author's reply to each: \`gh api repos/${opts.repo}/pulls/${opts.prNumber}/comments\`

These are last round's findings (with the original problem and the suggested fix; judge one by one whether the author addressed them):
${JSON.stringify(opts.findings.map((f) => ({ fid: f.fid, title: f.title, location: f.location, problem: f.problem, suggestedFix: f.fix, reviewerNote: f.notes })), null, 2)}

Judge the status of every existing finding (you must give one for every single finding):
- fixed: the author has properly fixed it the way the feedback asked (say in which commit/line they fixed it)
- partial: partly fixed / fixed incorrectly
- unaddressed: the author did not touch it
- replied: the author only replied in a comment without changing the code (check whether the reply holds up)

Also — this is a **key focus**: review whether the author's new batch of changes **itself introduces new problems/regressions** — fixing A breaking B, a missed call site, bugs in the new logic, breaking existing behaviour, and so on. Put what you find in newFindings (with the full fields severity/title/location/problem/fix); do **NOT** stuff them into rechecks. If there are none, give an empty array.

Finally give an **overall verdict after the recheck** in conclusion: pull this round's judgements together (what is fixed, what is not, whether anything new was introduced) and state which blockers remain and whether it can be merged now. This replaces the 「AI verdict」 shown in the UI — write it for the current state, do not copy the first review's conclusion.

Discipline: read-only (git diff/log/show, grep, gh pr view). ❌ Any git write operation is strictly forbidden.

Finally, **output JSON only** (no code fences):
{
  "rechecks": [ { "fid": "F1", "status": "fixed", "text": "explanation, citing the specific commit/line" } ],
  "newFindings": [ { "severity": "High|Medium|Low", "title": "one-line title", "location": "path:line",
    "problem": "why it is a problem", "detail": "details", "fix": "how to fix it", "text": "which commit/line introduced it" } ],
  "conclusion": "overall verdict after the recheck: which blockers remain, whether it can be merged"
}

${outputLangClause(resolveLang(opts.lang))}
⚠️ Strictly valid JSON: **never use an unescaped ASCII double quote \`"\`** inside text/problem and similar fields; always quote with 「」 or backticks \`, never ASCII double quotes.`
}

export async function runRecheckAgent(opts: RecheckAgentOptions): Promise<{ result: RecheckResult; costUsd: number; usage: ProviderUsage | null }> {
  const prompt = buildRecheckPrompt(opts)
  const stream = query({
    prompt,
    options: buildReviewOptions({ cwd: opts.cwd, model: opts.model, effort: opts.effort, methodology: withContract(opts.methodology), maxTurns: 40, mcpAllow: opts.mcpAllow, projectDirName: opts.projectDirName, abort: opts.abort, outputSchema: RECHECK_JSON_SCHEMA }),
  })
  let text = ''
  let costUsd = 0
  let usage: ProviderUsage | null = null
  let structured: unknown = null
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
      usage = usageFromClaudeResult(msg, opts.model)
      structured = (msg as any).structured_output ?? null
    }
  }
  const result = parseStructured(RecheckSchema, structured, text)
  return { result, costUsd, usage }
}

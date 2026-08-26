import { withContract } from './guard'
import { formatCodexProviderError, previewRawOutput, rawCodexErrorMessage } from './codexErrors'
import { runCodexReadonly } from '../codex/oneshot'
import {
  buildReviewPrompt,
  buildGuidedReviewPrompt,
  GuidedResultSchema,
  ReviewResultSchema,
  type GuidedResult,
  type GuidedReviewAgentOptions,
  type ReviewAgentOptions,
  type ReviewResult,
} from './review'
import { buildRecheckPrompt, RecheckSchema, type RecheckAgentOptions, type RecheckResult } from './recheck'
import { resolveLang } from './lang'
import type { ReviewRunner } from './runners'
import type { ProviderUsage } from '../runs/types'

// ── Structured-output JSON Schemas (aligned with their zod schemas, forcing Codex to emit parseable JSON) ──
const REVIEW_RESULT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          severity: { type: 'string', enum: ['High', 'Medium', 'Low'] },
          title: { type: 'string' },
          location: { type: 'string' },
          problem: { type: 'string' },
          detail: { type: 'string' },
          fix: { type: 'string' },
          introducedByPr: { type: 'boolean' },
        },
        required: ['severity', 'title', 'location', 'problem', 'detail', 'fix', 'introducedByPr'],
      },
    },
    logic: { type: 'string' },
    quality: { type: 'string' },
    risk: { type: 'string' },
    conclusion: { type: 'string' },
    requirement: { type: 'string' },
    testPath: { type: 'string' },
  },
  required: ['findings', 'logic', 'quality', 'risk', 'conclusion', 'requirement', 'testPath'],
} as const

const GUIDED_RESULT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          fid: { type: 'string' }, // only set when it matches an existing finding; new findings send an empty string (turned into absent at parse time)
          severity: { type: 'string', enum: ['High', 'Medium', 'Low'] },
          title: { type: 'string' },
          location: { type: 'string' },
          problem: { type: 'string' },
          detail: { type: 'string' },
          fix: { type: 'string' },
          introducedByPr: { type: 'boolean' },
          response: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: { type: 'string', enum: ['kept', 'retracted', 'adjusted', 'discuss', 'new'] },
              text: { type: 'string' },
            },
            required: ['status', 'text'],
          },
        },
        required: ['fid', 'severity', 'title', 'location', 'problem', 'detail', 'fix', 'introducedByPr', 'response'],
      },
    },
    logic: { type: 'string' },
    quality: { type: 'string' },
    risk: { type: 'string' },
    conclusion: { type: 'string' },
    requirement: { type: 'string' },
    testPath: { type: 'string' },
  },
  required: ['findings', 'logic', 'quality', 'risk', 'conclusion', 'requirement', 'testPath'],
} as const

const RECHECK_RESULT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    rechecks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          fid: { type: 'string' },
          status: { type: 'string', enum: ['fixed', 'partial', 'unaddressed', 'replied', 'new'] },
          text: { type: 'string' },
        },
        required: ['fid', 'status', 'text'],
      },
    },
    newFindings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          severity: { type: 'string', enum: ['High', 'Medium', 'Low'] },
          title: { type: 'string' },
          location: { type: 'string' },
          problem: { type: 'string' },
          detail: { type: 'string' },
          fix: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['severity', 'title', 'location', 'problem', 'detail', 'fix', 'text'],
      },
    },
    conclusion: { type: 'string' },
  },
  required: ['rechecks', 'newFindings', 'conclusion'],
} as const

export class CodexReviewError extends Error {
  override cause?: unknown

  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'CodexReviewError'
    this.cause = cause
  }
}

export function normalizeCodexReviewError(error: unknown): CodexReviewError {
  if (error instanceof CodexReviewError) return error
  return new CodexReviewError(formatCodexProviderError('review', error), error)
}

function stripJsonFence(raw: string): string {
  return raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
}

function parseJsonOrThrow(raw: string, label: string): unknown {
  const cleaned = stripJsonFence(raw)
  try {
    return JSON.parse(cleaned)
  } catch (error) {
    throw new CodexReviewError(`Codex ${label} returned invalid JSON: ${rawCodexErrorMessage(error)}. Raw output starts with: ${previewRawOutput(raw)}`, error)
  }
}

export function parseCodexReviewJson(raw: string): ReviewResult {
  const parsed = parseJsonOrThrow(raw, 'review')
  const result = ReviewResultSchema.safeParse(parsed)
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; ')
    throw new CodexReviewError(`Codex review JSON did not match ReviewResultSchema: ${issues}. Raw output starts with: ${previewRawOutput(raw)}`, result.error)
  }
  return result.data
}

export function parseCodexGuidedJson(raw: string): GuidedResult {
  const parsed = parseJsonOrThrow(raw, 'guided review') as { findings?: Array<{ fid?: string | null }> }
  // A new finding's fid is an empty string/null; zod's optional rejects null, and an empty string must not be taken for an existing finding → make it absent.
  if (parsed && Array.isArray(parsed.findings)) {
    for (const f of parsed.findings) if (f && !f.fid) delete f.fid
  }
  const result = GuidedResultSchema.safeParse(parsed)
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; ')
    throw new CodexReviewError(`Codex guided review JSON did not match GuidedResultSchema: ${issues}. Raw output starts with: ${previewRawOutput(raw)}`, result.error)
  }
  return result.data
}

export function parseCodexRecheckJson(raw: string): RecheckResult {
  const parsed = parseJsonOrThrow(raw, 'recheck')
  const result = RecheckSchema.safeParse(parsed)
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; ')
    throw new CodexReviewError(`Codex recheck JSON did not match RecheckSchema: ${issues}. Raw output starts with: ${previewRawOutput(raw)}`, result.error)
  }
  return result.data
}

function buildCodexReviewPrompt(opts: ReviewAgentOptions): string {
  return `${withContract(opts.methodology)}

---

${buildReviewPrompt({ ...opts, lang: resolveLang(opts.lang) })}`
}

// ── First review (codex) ──
export async function runCodexReviewAgent(opts: ReviewAgentOptions): Promise<{ result: ReviewResult; costUsd: number; raw: string; usage: ProviderUsage | null }> {
  try {
    const { raw, usage } = await runCodexReadonly({
    onStop: (stop) => { if (opts.abort?.signal.aborted) stop(); else opts.abort?.signal.addEventListener('abort', stop, { once: true }) },
      prompt: buildCodexReviewPrompt(opts),
      cwd: opts.cwd,
      model: opts.model,
      effort: opts.effort,
      serviceTier: opts.codexServiceTier,
      outputSchema: REVIEW_RESULT_JSON_SCHEMA,
      allowNetwork: true, // lets gh read PR metadata; write operations are blocked by the command guard
      mcpAllow: opts.mcpAllow,
      label: 'review',
      onTool: opts.onTool,
    })
    // costUsd stays a number for legacy consumers; the run record uses `usage` (null cost = unknown, never 0).
    return { result: parseCodexReviewJson(raw), costUsd: usage?.costUsd ?? 0, raw, usage }
  } catch (error) {
    throw normalizeCodexReviewError(error)
  }
}

// ── Targeted re-review with feedback (codex) ──
export async function runCodexGuidedReviewAgent(opts: GuidedReviewAgentOptions): Promise<{ result: GuidedResult; costUsd: number; usage: ProviderUsage | null }> {
  try {
    const { raw, usage } = await runCodexReadonly({
    onStop: (stop) => { if (opts.abort?.signal.aborted) stop(); else opts.abort?.signal.addEventListener('abort', stop, { once: true }) },
      prompt: `${withContract(opts.methodology)}\n\n---\n\n${buildGuidedReviewPrompt(opts)}\n\n(The structured output requires an fid field on every finding: use the existing finding's fid when it matches one, and set fid to the empty string "" for a new finding.)`,
      cwd: opts.cwd,
      model: opts.model,
      effort: opts.effort,
      serviceTier: opts.codexServiceTier,
      outputSchema: GUIDED_RESULT_JSON_SCHEMA,
      allowNetwork: true,
      mcpAllow: opts.mcpAllow,
      label: 'guided review',
      onTool: opts.onTool,
    })
    return { result: parseCodexGuidedJson(raw), costUsd: usage?.costUsd ?? 0, usage }
  } catch (error) {
    throw normalizeCodexReviewError(error)
  }
}

// ── Recheck after the author's update (codex) ── needs gh to read PR comments → allow network
export async function runCodexRecheckAgent(opts: RecheckAgentOptions): Promise<{ result: RecheckResult; costUsd: number; usage: ProviderUsage | null }> {
  try {
    const { raw, usage } = await runCodexReadonly({
    onStop: (stop) => { if (opts.abort?.signal.aborted) stop(); else opts.abort?.signal.addEventListener('abort', stop, { once: true }) },
      prompt: `${withContract(opts.methodology)}\n\n---\n\n${buildRecheckPrompt(opts)}`,
      cwd: opts.cwd,
      model: opts.model,
      effort: opts.effort,
      serviceTier: opts.codexServiceTier,
      outputSchema: RECHECK_RESULT_JSON_SCHEMA,
      allowNetwork: true,
      mcpAllow: opts.mcpAllow,
      label: 'recheck',
      onTool: opts.onTool,
    })
    return { result: parseCodexRecheckJson(raw), costUsd: usage?.costUsd ?? 0, usage }
  } catch (error) {
    throw normalizeCodexReviewError(error)
  }
}

export const codexReviewRunner: ReviewRunner = {
  runReview: runCodexReviewAgent,
  runGuidedReview: runCodexGuidedReviewAgent,
  runRecheck: runCodexRecheckAgent,
}

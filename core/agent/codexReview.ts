import { withContract } from './guard'
import { formatCodexProviderError, previewRawOutput, rawCodexErrorMessage } from './codexErrors'
import { runCodexReadonly } from './codexAgent'
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
import type { ReviewRunner } from './runners'

// ── 结构化输出 JSON Schema（与各自的 zod schema 对齐，让 Codex 强制产出可解析 JSON）──
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
          fid: { type: 'string' }, // 命中已有 finding 才有 fid；新发现给空串（解析时转成缺省）
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
  // 新发现的 fid 是空串/null；zod 的 optional 不接受 null、也不该把空串当已有 finding → 转成缺省。
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

${buildReviewPrompt({ ...opts, lang: opts.lang || 'zh' })}`
}

// ── 首审（codex）──
export async function runCodexReviewAgent(opts: ReviewAgentOptions): Promise<{ result: ReviewResult; costUsd: number; raw: string }> {
  try {
    const raw = await runCodexReadonly({
      prompt: buildCodexReviewPrompt(opts),
      cwd: opts.cwd,
      model: opts.model,
      effort: opts.effort,
      serviceTier: opts.codexServiceTier,
      outputSchema: REVIEW_RESULT_JSON_SCHEMA,
      allowNetwork: true, // 让 gh 能读 PR 元数据；写操作由命令守卫拦截
      label: 'review',
      onTool: opts.onTool,
    })
    return { result: parseCodexReviewJson(raw), costUsd: 0, raw }
  } catch (error) {
    throw normalizeCodexReviewError(error)
  }
}

// ── 带反馈的针对性复审（codex）──
export async function runCodexGuidedReviewAgent(opts: GuidedReviewAgentOptions): Promise<{ result: GuidedResult; costUsd: number }> {
  try {
    const raw = await runCodexReadonly({
      prompt: `${withContract(opts.methodology)}\n\n---\n\n${buildGuidedReviewPrompt(opts)}\n\n（结构化输出要求每条 finding 都带 fid 字段：命中已有 finding 用其 fid，新发现请把 fid 设为空字符串 ""。）`,
      cwd: opts.cwd,
      model: opts.model,
      effort: opts.effort,
      serviceTier: opts.codexServiceTier,
      outputSchema: GUIDED_RESULT_JSON_SCHEMA,
      allowNetwork: true,
      label: 'guided review',
      onTool: opts.onTool,
    })
    return { result: parseCodexGuidedJson(raw), costUsd: 0 }
  } catch (error) {
    throw normalizeCodexReviewError(error)
  }
}

// ── 作者更新后复审（codex）── 需要 gh 读 PR 评论 → 放开网络
export async function runCodexRecheckAgent(opts: RecheckAgentOptions): Promise<{ result: RecheckResult; costUsd: number }> {
  try {
    const raw = await runCodexReadonly({
      prompt: `${withContract(opts.methodology)}\n\n---\n\n${buildRecheckPrompt(opts)}`,
      cwd: opts.cwd,
      model: opts.model,
      effort: opts.effort,
      serviceTier: opts.codexServiceTier,
      outputSchema: RECHECK_RESULT_JSON_SCHEMA,
      allowNetwork: true,
      label: 'recheck',
      onTool: opts.onTool,
    })
    return { result: parseCodexRecheckJson(raw), costUsd: 0 }
  } catch (error) {
    throw normalizeCodexReviewError(error)
  }
}

export const codexReviewRunner: ReviewRunner = {
  runReview: runCodexReviewAgent,
  runGuidedReview: runCodexGuidedReviewAgent,
  runRecheck: runCodexRecheckAgent,
}

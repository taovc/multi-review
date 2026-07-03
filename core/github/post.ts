import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFile, rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runClaude } from '../agent/claudeCli'
import { runCodexText } from '../agent/codexAgent'
import type { ReviewProvider } from '../agent/runners'

const pexec = promisify(execFile)

export type PostFinding = {
  fid: string
  severity: 'High' | 'Medium' | 'Low'
  title: string
  location: string | null
  problem: string | null
  detail: string | null
  fix: string | null
  notes: string | null
  introducedByPr: boolean
  // 最新一轮复审结论（没复审过就是 null）→ 决定这条评论怎么发
  recheck: { status: string; text: string | null } | null
}

// 一条 finding 经过复审后，发评论时按最新一轮复审状态决定怎么处理：
//   fixed     → 不重发原文，进 summary 的「已确认修复」一行
//   partial   → 发评论，但只说「还差什么」
//   replied   → 作者回过、代码没改：有你的新 note 才发（针对作者回应的再回应），没 note 就跳过
//   retracted → AI 已撤回这条，别发
//   其它/无复审 → 正常发原 finding（finding 内容即当前结论）
type Plan =
  | { action: 'comment'; kind: 'normal' | 'partial' | 'reply' }
  | { action: 'fixed' }
  | { action: 'skip'; reason: 'replied-no-note' | 'retracted' }

function planFinding(f: PostFinding): Plan {
  const st = f.recheck?.status
  const hasNote = !!(f.notes && f.notes.trim())
  if (st === 'fixed') return { action: 'fixed' }
  if (st === 'retracted') return { action: 'skip', reason: 'retracted' }
  if (st === 'partial') return { action: 'comment', kind: 'partial' }
  if (st === 'replied' || st === 'discuss')
    return hasNote ? { action: 'comment', kind: 'reply' } : { action: 'skip', reason: 'replied-no-note' }
  return { action: 'comment', kind: 'normal' }
}

// diff 中新文件侧（RIGHT）可评论的行号集合，按文件
function rightLines(diff: string): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>()
  let cur: Set<number> | null = null
  let newLine = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ b/')) {
      cur = new Set()
      map.set(line.slice(6), cur)
    } else if (line.startsWith('+++ ')) {
      cur = null
    } else if (line.startsWith('@@')) {
      const m = line.match(/\+(\d+)/)
      newLine = m ? Number(m[1]) : 0
    } else if (cur) {
      if (line.startsWith('+')) cur.add(newLine++)
      else if (line.startsWith('-') || line.startsWith('\\')) {
        /* 旧侧 / no-newline，不推进新行号 */
      } else {
        cur.add(newLine++) // 上下文
      }
    }
  }
  return map
}

function parseLoc(loc: string | null): { path: string; line: number } | null {
  if (!loc) return null
  const m = loc.match(/^(.+?):(\d+)/)
  if (!m) return null
  return { path: m[1]!, line: Number(m[2]) }
}

// 把中文 findings 翻成英文 PR 评论正文（GitHub 对外内容用英文）。一次性文本生成。
// 按项目 provider 分流：claude 走 `claude --print`（stdin 喂 prompt，避免 server 里等 stdin 卡死）；
// codex 走 Codex SDK 的一次性 run()。**不混用**：codex 项目的翻译也由 codex 产出。
async function claudePrint(model: string, prompt: string): Promise<string> {
  const out = await runClaude(['--print', '--model', model || 'sonnet'], { input: prompt, timeout: 120_000 })
  return String(out).trim()
}
function makePrint(provider: ReviewProvider, model: string, cwd?: string, codexServiceTier?: string | null): (prompt: string) => Promise<string> {
  if (provider === 'codex') return (prompt) => runCodexText({ prompt, model: model || undefined, cwd, serviceTier: codexServiceTier })
  return (prompt) => claudePrint(model, prompt)
}

// 每条 finding 独立并行翻译（每个调用输出小、几秒）→ 墙钟 ≈ 最慢的一条，而非全部串起来。
async function translate(
  provider: ReviewProvider,
  model: string,
  cwd: string | undefined,
  codexServiceTier: string | null | undefined,
  findings: PostFinding[],
  globalNotes: string,
): Promise<{ globalNotesEn: string; bodies: Record<string, string> }> {
  const print = makePrint(provider, model, cwd, codexServiceTier)
  const tasks: Promise<void>[] = []
  const bodies: Record<string, string> = {}
  let globalNotesEn = ''

  if (globalNotes.trim()) {
    tasks.push(
      print(`Translate this PR-review preface (any source language) into concise professional English. Output ONLY the English text, no preamble:\n\n${globalNotes}`)
        .then((t) => { globalNotesEn = t }),
    )
  }

  const strip = (t: string) => t.replace(/^```(?:markdown|md)?\s*/i, '').replace(/```\s*$/i, '').trim()

  for (const f of findings) {
    const plan = planFinding(f)
    if (plan.action === 'skip') continue // 跳过的不发、不用翻译

    const one = {
      severity: f.severity, title: f.title, problem: f.problem, detail: f.detail,
      fix: f.fix, preexisting: !f.introducedByPr,
    }
    const hasNote = !!(f.notes && f.notes.trim())
    // note = 审核员对这条"怎么写评论"的指令（调语气/取舍内容/补充上下文/降级措辞…），融进评论，不原样贴出
    const noteClause = hasNote
      ? `\n\nThe reviewer left a NOTE on this finding. Treat it as an INSTRUCTION for how to write/adjust THIS comment — e.g. soften or sharpen tone, add or drop detail, add context, downgrade/reframe, merge wording. Follow it and weave its intent into the comment. **Do NOT output the note text verbatim, and do NOT add a separate "Reviewer note" line** — it is guidance for you, not text for the PR author.\nReviewer note (source language): ${f.notes}`
      : ''
    const verdict = f.recheck?.text || '' // 最新一轮复审结论（作者改了没 / 回应了啥）

    let prompt: string
    if (plan.action === 'fixed') {
      // 已确认修复：一句话进 summary 的「Confirmed fixed」清单（纯文本，无标题/无围栏）
      prompt = `The author CONFIRMED-FIXED this PR-review finding. Write ONE short professional English sentence acknowledging it's resolved, naming the topic so the author knows which finding. Plain text only — no markdown heading, no bullet, no code fence.
FINDING TITLE (source language): ${f.title}
RE-REVIEW NOTE (source language): ${verdict}`
    } else if (plan.kind === 'partial') {
      // 部分修复 / 改得不对：只说还差什么
      prompt = `Write ONE finding of a GitHub PR review as professional English markdown. This finding was RE-REVIEWED: the author's latest changes only PARTIALLY addressed it (or addressed it incorrectly). Focus the comment on WHAT IS STILL MISSING OR WRONG — briefly acknowledge what was done, then state precisely what remains. Do NOT restate the whole original finding.
Output ONLY the markdown body — a bold line "**[<severity>] <title>**", then the remaining problem, then a fix section. Keep file paths, line numbers, identifiers and any code fences UNCHANGED.${noteClause}

RE-REVIEW VERDICT (source language): ${verdict}
ORIGINAL FINDING (source language): ${JSON.stringify(one)}`
    } else if (plan.kind === 'reply') {
      // 作者回过、代码没改：发针对作者回应的再回应（note 是审核员要回的话，不是"怎么写评论"的指令）
      prompt = `Write ONE GitHub PR-review comment as professional English markdown. Context: you previously raised the finding below; the author REPLIED in the PR but did NOT change the code. Respond to the author's reply and move the discussion forward — concede, push back with reasoning, or ask for clarification — per the reviewer's response. Do NOT just restate the original finding.
Output ONLY the markdown body (you may open with a bold "**[<severity>] <title>**" line). Keep file paths, line numbers, identifiers and any code fences UNCHANGED.

AUTHOR'S REPLY / RE-REVIEW VERDICT (source language): ${verdict}
REVIEWER'S RESPONSE TO THE AUTHOR (source language — weave its intent into the comment, do NOT quote verbatim): ${f.notes}
ORIGINAL FINDING for context (source language): ${JSON.stringify(one)}`
    } else {
      // normal：翻译原 finding（原逻辑）
      prompt = `Write ONE finding of a GitHub PR review as professional English markdown. Output ONLY the markdown body — no preamble, no outer code fences.
Format: a bold line "**[<severity>] <title>**", then the problem, then detail (keep any lists), then a fix section. If "preexisting" is true, note "(pre-existing, not introduced by this PR)". Keep file paths, line numbers, identifiers and any code fences UNCHANGED. Translate the content to professional English (source may be any language).${noteClause}

FINDING (source language):
${JSON.stringify(one)}`
    }
    tasks.push(print(prompt).then((t) => { bodies[f.fid] = strip(t) }))
  }

  // 单条翻译失败不毁掉整次发布：失败的 finding 在 assemble 时回退到原标题
  await Promise.allSettled(tasks)
  return { globalNotesEn, bodies }
}

export type AssembledReview = {
  body: string
  comments: { path: string; line: number; side: 'RIGHT'; body: string }[]
  mode: 'review' | 'comment' | 'mixed'
  // 按复审状态没发的勾选项（replied 无 note / 已撤回）→ 预览里告知用户，免得以为漏发
  skipped: { fid: string; title: string; reason: 'replied-no-note' | 'retracted' }[]
}

export async function assembleReview(opts: {
  provider?: ReviewProvider
  model: string
  codexServiceTier?: string | null
  cwd?: string // codex 翻译需要一个 workingDirectory（项目本地 clone 路径），缺省则 skipGitRepoCheck
  findings: PostFinding[]
  globalNotes: string
  diff: string
}): Promise<AssembledReview> {
  const { globalNotesEn, bodies } = await translate(opts.provider === 'codex' ? 'codex' : 'claude', opts.model, opts.cwd, opts.codexServiceTier, opts.findings, opts.globalNotes)
  const right = rightLines(opts.diff)

  const comments: AssembledReview['comments'] = []
  const summaryFindings: PostFinding[] = []
  const confirmedFixed: string[] = [] // 已确认修复 → summary 一行
  const skipped: AssembledReview['skipped'] = []
  for (const f of opts.findings) {
    const plan = planFinding(f)
    if (plan.action === 'skip') { skipped.push({ fid: f.fid, title: f.title, reason: plan.reason }); continue }
    if (plan.action === 'fixed') { confirmedFixed.push(bodies[f.fid] || f.title); continue }
    const loc = parseLoc(f.location)
    // 不可见元数据标记：GitHub 渲染时看不见，但「修复 PR」验证阶段能据此无损还原结构化 finding（#16）
    const marker = `<!-- mr:fid=${f.fid} sev=${f.severity} -->\n`
    if (loc && right.get(loc.path)?.has(loc.line)) {
      comments.push({ path: loc.path, line: loc.line, side: 'RIGHT', body: marker + (bodies[f.fid] || f.title) })
    } else {
      summaryFindings.push(f)
    }
  }

  let body = ''
  if (globalNotesEn.trim()) body += `## Re-review notes\n\n${globalNotesEn.trim()}\n\n`
  if (summaryFindings.length) {
    body += `### Additional findings (not tied to changed lines)\n\n`
    for (const f of summaryFindings) {
      body += `<!-- mr:fid=${f.fid} sev=${f.severity} -->\n${bodies[f.fid] || f.title}\n\n`
      if (f.location) body += `\`${f.location}\`\n\n`
      body += `---\n\n`
    }
  }
  if (confirmedFixed.length) {
    body += `### Confirmed fixed\n\n`
    for (const line of confirmedFixed) body += `- ${line}\n`
    body += `\n`
  }
  if (!body.trim()) body = comments.length ? 'See inline comments.' : ''

  const mode: AssembledReview['mode'] =
    comments.length && (summaryFindings.length || confirmedFixed.length) ? 'mixed' : comments.length ? 'review' : 'comment'
  return { body, comments, mode, skipped }
}

// 真正提交一个 PR review（行级 + 汇总）。422（行不在 diff）则全部并进 body 重发一次。
export async function postReview(opts: {
  repo: string
  prNumber: number
  headSha: string
  assembled: AssembledReview
}): Promise<{ url: string }> {
  const { repo, prNumber, headSha, assembled } = opts

  // 自愈：先清掉本人残留的 PENDING review（GitHub 只允许每人每 PR 一个 pending，残留会让新 review 422）。
  // GET 返回里能看到的 PENDING 一定是自己的（别人的 pending 不可见），直接删。
  try {
    // 带 timeout：这两步在 review 的 'posting' 认领窗口内跑，gh 若无限挂起会把行永久卡在 'posting'（recover 只在启动跑）。
    const { stdout } = await pexec('gh', ['api', `repos/${repo}/pulls/${prNumber}/reviews`, '--paginate', '--slurp'], { maxBuffer: 1024 * 1024 * 16, timeout: 30_000 })
    for (const r of (JSON.parse(stdout) as any[][]).flat()) {
      if (r.state === 'PENDING') {
        await pexec('gh', ['api', `repos/${repo}/pulls/${prNumber}/reviews/${r.id}`, '--method', 'DELETE'], { timeout: 30_000 }).catch(() => {})
      }
    }
  } catch {
    /* 清理失败不阻断，下面真发时若撞上会报错 */
  }

  // payload 写临时文件再 --input <file>（async execFile 不支持 stdin input，会卡死）
  const run = async (payload: object) => {
    const dir = await mkdtemp(join(tmpdir(), 'mr-post-'))
    const file = join(dir, 'payload.json')
    await writeFile(file, JSON.stringify(payload))
    try {
      const { stdout } = await pexec(
        'gh',
        ['api', `repos/${repo}/pulls/${prNumber}/reviews`, '--method', 'POST', '--input', file],
        { maxBuffer: 1024 * 1024 * 16, timeout: 60_000 },
      )
      return JSON.parse(stdout)
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }

  const payload = {
    commit_id: headSha,
    event: 'COMMENT',
    body: assembled.body,
    comments: assembled.comments,
  }
  try {
    const res = await run(payload)
    return { url: res.html_url || res._links?.html?.href || '' }
  } catch (e: any) {
    const stderr = e?.stderr?.toString?.() ?? ''
    if (/422/.test(stderr) || /line must be part of the diff/i.test(stderr)) {
      // 退化：行级全并进 body 重发（review 原子，前次未发出）
      const merged =
        assembled.body +
        '\n\n' +
        assembled.comments.map((c) => `**\`${c.path}:${c.line}\`**\n\n${c.body}`).join('\n\n---\n\n')
      const res = await run({ commit_id: headSha, event: 'COMMENT', body: merged, comments: [] })
      return { url: res.html_url || '' }
    }
    throw new Error(`发布 review 失败: ${stderr || e?.message}`)
  }
}

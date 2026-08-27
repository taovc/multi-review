import type { EvalSummary } from './runner'

const pct = (v: number | null | undefined) => (v == null ? '—' : `${(v * 100).toFixed(0)}%`)
const usd = (v: number | null | undefined) => (v == null ? '—' : `$${v.toFixed(3)}`)

export function renderReport(s: EvalSummary): string {
  const lines: string[] = []
  lines.push(`# Eval ${s.golden.name} · ${s.provider} ${s.model || '(default)'} ${s.effort || ''}`.trim())
  lines.push('')
  lines.push(`- run id: \`${s.id}\` · ${s.startedAt} → ${s.endedAt}`)
  lines.push(`- methodology: ${s.skillVersionId ? `skill version \`${s.skillVersionId}\`` : 'inline'} (sha ${s.methodologySha.slice(0, 12)})`)
  lines.push(`- cases: ${s.cases.length} (${s.cases.filter((c) => c.status === 'done').length} done, ${s.cases.filter((c) => c.status === 'error').length} errored) · cost ${usd(s.costUsd)} · ${Math.round(s.durationMs / 1000)}s`)
  lines.push('')
  lines.push('| | TP | FP | FN | precision | recall | F1 |')
  lines.push('|---|---|---|---|---|---|---|')
  lines.push(`| review | ${s.tp} | ${s.fp} | ${s.fn} | ${pct(s.precision)} | ${pct(s.recall)} | ${pct(s.f1)} |`)
  if (s.verify) lines.push(`| after verify (refuted dropped) | ${s.verified!.tp} | ${s.verified!.fp} | ${s.verified!.fn} | ${pct(s.verified!.precision)} | ${pct(s.verified!.recall)} | ${pct(s.verified!.f1)} |`)
  lines.push('')
  if (s.verify) lines.push(`Verify pass: ${s.verifyStats!.refutedFp} false positives refuted, ${s.verifyStats!.refutedTp} true positives wrongly refuted, ${s.verifyStats!.unsure} unsure · extra cost ${usd(s.verifyStats!.costUsd)}.`)
  lines.push('')
  lines.push('## Cases')
  lines.push('')
  for (const c of s.cases) {
    lines.push(`### PR #${c.prNumber} @ ${c.headSha.slice(0, 7)} — ${c.status}${c.error ? `: ${c.error}` : ''}`)
    lines.push(`TP ${c.tp} · FP ${c.fp} · FN ${c.fn} · cost ${usd(c.costUsd)} · ${Math.round(c.durationMs / 1000)}s`)
    if (c.missedLabelIds.length) lines.push(`missed labels: ${c.missedLabelIds.join(', ')}`)
    lines.push('')
    for (const f of c.findings) {
      const tag = f.matchedLabelId ? `✓ ${f.matchedLabelId}` : '✗ unmatched'
      const v = f.verifyStatus ? ` · verify=${f.verifyStatus}` : ''
      lines.push(`- ${tag}${v} · ${f.fid} [${f.severity}] ${f.title} — ${f.location || ''}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

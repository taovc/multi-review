import type { TimelineNode, ReviewComment } from '~core/github/gh'

// 把 PR 上的评论（行级 + 顶层 review/comment）整理成一份给「修复」agent 的整改清单。
// 重点：把人类/机器人留下的、需要处理的反馈结构化，按文件分组，方便 agent 定位改动。
export function buildFixBrief(opts: {
  prNumber: number
  timeline: TimelineNode[]
  reviewComments: ReviewComment[]
  diff?: string
}): string {
  const { prNumber, timeline, reviewComments, diff } = opts
  const parts: string[] = []

  // 1) 行级 review 评论，按文件分组
  if (reviewComments.length) {
    const byFile = new Map<string, ReviewComment[]>()
    for (const c of reviewComments) {
      const key = c.path || '(général)'
      const list = byFile.get(key) ?? []
      list.push(c)
      byFile.set(key, list)
    }
    parts.push(`## Commentaires en ligne (${reviewComments.length})`)
    for (const [file, list] of byFile) {
      parts.push(`\n### ${file}`)
      for (const c of list) {
        const loc = c.line != null ? `:${c.line}` : ''
        const who = `${c.author}${c.isBot ? ' (bot)' : ''}`
        const reply = c.inReplyToId != null ? ' [réponse]' : ''
        parts.push(`- **${file}${loc}** — ${who}${reply}\n  ${oneBlock(c.body)}`)
      }
    }
  }

  // 2) 顶层 review 总结 + 会话评论（有正文的才有用）
  const tops = timeline.filter(
    (n) => (n.kind === 'review' || n.kind === 'comment') && (n.body ?? '').trim(),
  )
  if (tops.length) {
    parts.push(`\n## Revues & commentaires généraux (${tops.length})`)
    for (const n of tops) {
      const who = `${n.actor}${n.isBot ? ' (bot)' : ''}`
      const state = n.state ? ` · ${n.state}` : ''
      parts.push(`- **${who}**${state}\n  ${oneBlock(n.body ?? '')}`)
    }
  }

  if (!reviewComments.length && !tops.length) {
    parts.push(`_Aucun commentaire textuel sur la PR #${prNumber}. Améliore le code selon les bonnes pratiques générales._`)
  }

  // 3) diff de la PR pour contexte (tronqué — l'agent a aussi le code dans le worktree)
  if (diff && diff.trim()) {
    const MAX = 20_000
    const body = diff.length > MAX ? diff.slice(0, MAX) + '\n… (diff tronqué)' : diff
    parts.push(`\n## Diff de la PR (contexte)\n\`\`\`diff\n${body}\n\`\`\``)
  }

  return parts.join('\n')
}

// Aplati un corps de commentaire multi-lignes en un bloc indenté lisible.
function oneBlock(body: string): string {
  return body.trim().split('\n').join('\n  ')
}

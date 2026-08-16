import { pickByLang } from '../agent/lang'
import { reviewFindingStats } from './findings'

// 自动修复给 agent 的默认指令：把这条审核里「还需处理」的 finding（口径统一在 findings.ts）列清楚，
// 让它在 worktree 里改（不提交，沿用 fix 管线）。语言跟这次审核的工作语言走 —— 这段会直接进 agent 的
// 对话，也会在 UI 上作为用户消息展示，所以三种语言各写一份，不要用「不是英文就中文」的二分。
const FIX_MESSAGE = {
  zh: {
    header: '请逐条处理下面这些代码审核发现的问题，直接修改 worktree 里的文件（不要 commit，由上传流程统一提交）。修完后简述每条怎么改的。',
    problem: '问题',
    fix: '建议',
  },
  en: {
    header: 'Address each of the following code-review findings by editing the files in the worktree (do NOT commit — the upload step handles that). After fixing, briefly explain what you changed for each.',
    problem: 'Problem',
    fix: 'Suggested fix',
  },
  fr: {
    header: 'Traite chacun des points de revue ci-dessous en modifiant les fichiers du worktree (ne fais PAS de commit — l’étape d’envoi s’en charge). Une fois corrigé, explique brièvement ce que tu as changé pour chacun.',
    problem: 'Problème',
    fix: 'Correction suggérée',
  },
}

export function buildAutoFixMessage(db: any, schema: any, reviewId: string, lang: string): string | null {
  const todo = reviewFindingStats(db, schema, reviewId).actionableFindings
  if (!todo.length) return null

  const t = pickByLang(lang, FIX_MESSAGE)
  const lines = todo.map((f) => {
    const loc = f.location ? ` (${f.location})` : ''
    const prob = f.problem ? `\n  - ${t.problem}: ${f.problem}` : ''
    const fix = f.fix ? `\n  - ${t.fix}: ${f.fix}` : ''
    return `${f.fid} [${f.severity}] ${f.title}${loc}${prob}${fix}`
  })
  return `${t.header}\n\n${lines.join('\n\n')}`
}

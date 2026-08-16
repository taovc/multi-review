// Health-check the skill content: look for suspected "operational-procedure contamination" (a skill should only state review
// criteria, not git/worktree/fix operating instructions).
// Note: false positives happen (a methodology that merely mentions push descriptively also matches) → warn only, never auto-block;
// the hard block at the tool layer is the backstop.
// What we match is the text the user wrote into the skill, whose language follows the skill body (zh/en/fr all possible)
// → every pattern lists all three languages.
const RULES: { re: RegExp; why: string }[] = [
  { re: /\bgit\s+(commit|push|add|reset|rebase|merge|checkout|restore|stash|clean|cherry-pick)\b/i, why: '提到 git 写操作' },
  {
    re: /(顺便|顺手|直接)\s*(修|改)|修复\s*bug|自动修复|帮.{0,4}改|fix\s+the\s+bug|while\s+you(?:'|’)?re\s+at\s+it|(?:just|go\s+ahead\s+and)\s+fix|corrige[rz]?\s+(?:le\s+)?bug|au\s+passage/i,
    why: '疑似要求"顺手修复/改代码"（应只审不改）',
  },
  {
    re: /(不创建|跳过|不用|不开|无需)\s*worktree|直接在\s*(主|master|main|dev)\s*分支|(?:skip|without)\s+(?:a\s+|the\s+)?worktree|directly\s+on\s+(?:the\s+)?(?:main|master|dev)\s+branch|sans\s+worktree|directement\s+sur\s+(?:la\s+branche\s+)?(?:main|master|dev)/i,
    why: '疑似要求跳过 worktree 隔离',
  },
  { re: /\bgh\s+pr\s+(comment|review|merge|close|edit|create)\b/i, why: '提到 gh 写操作（发评论/合并/改 PR）' },
  { re: /\b(commit\s+and\s+push|commit\s+&|push\s+to\s+(origin|remote))\b/i, why: '提到提交并推送' },
]

// Negation/prohibition wording: such a line is forbidding an operation (i.e. declaring a boundary), which is not contamination.
// This also has to cover all three languages, otherwise boundary statements in English/French methodologies get reported as
// contamination by the rules above.
const NEGATION = new RegExp(
  [
    '绝不|禁止|严禁|不得|不要|不能|不准|不会|不应|无需|勿|别\\s|只描述|只审不改|不修改|不动',
    'never|do\\s+not|don(?:\'|’)?t|must\\s+not|cannot|can(?:\'|’)?t|no\\s+need\\s+to|avoid|forbidden|prohibited|read-only|without\\s+(?:modifying|changing|editing)',
    'ne\\s+jamais|ne\\s+(?:pas|doit|dois|devez)|interdit|sans\\s+(?:modifier|changer)|aucun\\s+besoin|lecture\\s+seule',
  ].join('|'),
  'i',
)

export function lintSkill(content: string): string[] {
  const hits = new Set<string>()
  for (const line of (content || '').split('\n')) {
    if (NEGATION.test(line)) continue // skip rule-describing lines that carry a negation (e.g. "绝不顺手修", "禁止 git push")
    for (const r of RULES) if (r.re.test(line)) hits.add(r.why)
  }
  return [...hits]
}

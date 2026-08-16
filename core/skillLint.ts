// 体检 skill 内容：找疑似"操作流程污染"（应只写审核准则，不写 git/worktree/修复 等操作指令）。
// 注意：会有误报（方法学里描述性提到 push 也会命中）→ 所以只警告，不自动拦，配合工具层硬拦截兜底。
// 匹配的是用户写进 skill 的文本，语言跟着技能正文走（zh/en/fr 都可能）→ 每条模式三语并列。
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

// 否定/禁止性表述：这一行是在"禁止/不要做某操作"（即声明边界），不算污染。同样要覆盖三种语言，
// 否则英文/法文方法学里的边界声明会被上面的规则当成污染报出来。
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
    if (NEGATION.test(line)) continue // 带否定词的规则描述行跳过（如"绝不顺手修"、"禁止 git push"）
    for (const r of RULES) if (r.re.test(line)) hits.add(r.why)
  }
  return [...hits]
}

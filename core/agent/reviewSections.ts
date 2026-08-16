// Section labels are a protocol between two ends that must not drift apart:
//   - the review prompt tells the model to break requirement / testPath into these sections;
//   - the review panel's readability formatter inserts a blank line before each of them.
//
// The model writes the labels in the current working language (which follows the UI locale), so
// the matcher has to recognise all three languages even though the prompt only names the English
// ones. Renaming a section in the prompt without adding it here silently degrades the rendering
// into one unbroken blob — no error, just a wall of text.
//
// Keep this module dependency-free: it is imported by a Vue component through the `~core` alias
// and must not pull server-only code into the client bundle.

// Canonical section names, exactly as the prompt names them.
export const REVIEW_SECTIONS = ['positive case', 'negative / edge cases', 'regression points'] as const

const LABEL_PATTERNS = [
  // zh — what the model writes under the default working language
  '用户视角[^：:]*', '正向\\s*case', '负向\\s*\\/?\\s*边界', '负向', '边界', '回归点', '受影响的人', '改动前', '改动后',
  // en — must cover every name in REVIEW_SECTIONS (locked by tests/review-sections.test.ts)
  'user\\s+perspective', 'positive\\s+case', 'negative\\s*[\\/&]?\\s*edge(?:\\s+cases?)?', 'edge\\s+cases?',
  'regression(?:\\s+points?)?', 'affected(?:\\s+(?:users?|people|parties))?', 'before\\s+the\\s+change', 'after\\s+the\\s+change',
  // fr
  'perspective\\s+utilisateur', 'cas\\s+positif', 'cas\\s+n[ée]gatif(?:s)?(?:\\s*\\/?\\s*limites)?', 'limites',
  'points?\\s+de\\s+r[ée]gression', 'personnes?\\s+concern[ée]es?', 'avant\\s+(?:le\\s+)?changement', 'apr[èe]s\\s+(?:le\\s+)?changement',
]

// Returns a fresh regex each call — a shared /g regex carries lastIndex state across .test()/.exec().
export function reviewSectionRe(): RegExp {
  return new RegExp(`\\s*(${LABEL_PATTERNS.join('|')})([：:])`, 'gi')
}

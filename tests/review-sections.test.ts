import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REVIEW_SECTIONS, reviewSectionRe } from '../core/agent/reviewSections'
import { buildReviewPrompt } from '../core/agent/review'

// The review prompt names the sections; the review panel inserts a blank line before them.
// If the prompt renames one and the matcher is not updated, nothing errors — the requirement /
// test path just renders as one unbroken wall of text. Lock both ends together.

// 1) Every section name the prompt uses is recognised by the matcher.
for (const s of REVIEW_SECTIONS) {
  assert.match(`${s}:`, reviewSectionRe(), `prompt section "${s}" is not recognised by reviewSectionRe()`)
}

// 2) The prompt really does carry those names.
const prompt = buildReviewPrompt({ repo: 'o/r', prNumber: 1, branch: 'b', defaultBranch: 'main', lang: 'en' })
for (const s of REVIEW_SECTIONS) {
  assert.ok(prompt.includes(s), `buildReviewPrompt should name the section "${s}"`)
}

// 3) The other two working languages still split (the AI writes the labels in the output language).
for (const label of ['用户视角', '回归点', '正向 case', '负向/边界', 'user perspective', 'regression points', 'perspective utilisateur', 'points de régression']) {
  assert.match(`${label}：`, reviewSectionRe(), `"${label}" should be recognised as a section label`)
  assert.match(`${label}:`, reviewSectionRe(), `"${label}" with an ASCII colon should be recognised`)
}

// 4) A fresh regex per call — a shared /g regex would carry lastIndex across .test() calls.
const re = reviewSectionRe()
assert.notEqual(re, reviewSectionRe())
assert.equal(re.lastIndex, 0)

// 5) The formatter's actual substitution puts a blank line in front of each section.
const formatted = 'Steps 1 2 3 positive case: click save negative / edge cases: empty input regression points: none'
  .replace(reviewSectionRe(), '\n\n$1$2')
assert.equal(formatted.split('\n\n').length, 4, 'each section label should start a new block')

console.log('review-sections: ok')

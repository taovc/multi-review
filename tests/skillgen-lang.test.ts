import assert from 'node:assert/strict'
import { buildSkillPrompt } from '../core/agent/skillgen'
import { langName, resolveLang } from '../core/agent/lang'

// Output language follows the UI locale (#16 working language): the assertion is anchored on the
// result of langName(), not on the prompt wording, so rewriting the prompt won't break this test.
const directive = (lang: string) => new RegExp(`Write the entire methodology in ${langName(lang)}\\b`)

for (const lang of ['fr', 'en', 'zh']) {
  assert.match(buildSkillPrompt({ lang }), directive(lang))
}

// No more hardcoded Chinese: for locales other than zh, the prompt must not contain a fixed
// "must use Chinese" style instruction.
assert.doesNotMatch(buildSkillPrompt({ lang: 'fr' }), /Chinese/)
assert.doesNotMatch(buildSkillPrompt({ lang: 'en' }), /Chinese/)

// A full locale code (e.g. fr-FR) must resolve correctly too.
assert.match(buildSkillPrompt({ lang: 'fr-FR' }), directive('fr'))

// Default (no lang) → falls back to Chinese, consistent with the other core agents and every
// endpoint, rather than silently switching to English.
assert.equal(resolveLang(undefined), 'zh')
assert.equal(resolveLang('de'), 'zh')
assert.match(buildSkillPrompt({}), directive('zh'))

// Optimize path: the base content is injected and the language directive is still there.
const optimize = buildSkillPrompt({ lang: 'fr', baseContent: '# Old skill' })
assert.match(optimize, directive('fr'))
assert.match(optimize, /# Old skill/)

console.log('skillgen-lang: ok')

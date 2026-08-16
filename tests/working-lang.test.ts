import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_LANG, langName, outputLangClause, pickByLang, resolveLang } from '../core/agent/lang'
import { lintSkill } from '../core/skillLint'

// ── Working-language normalization ──
// One entry point for the whole repo: a user's choice (the mr-locale cookie) drives both the UI
// and the AI output language, and anything unreadable — no cookie, an unsupported locale, a
// timer-driven job with no request at all — falls back to DEFAULT_LANG.
assert.equal(resolveLang('zh'), 'zh')
assert.equal(resolveLang('en'), 'en')
assert.equal(resolveLang('fr'), 'fr')
assert.equal(resolveLang('fr-FR'), 'fr')
assert.equal(resolveLang('EN-us'), 'en')
assert.equal(resolveLang('de'), DEFAULT_LANG)
assert.equal(resolveLang(''), DEFAULT_LANG)
assert.equal(resolveLang(null), DEFAULT_LANG)
assert.equal(resolveLang(undefined), DEFAULT_LANG)

assert.equal(langName('fr-FR'), 'French')
assert.equal(langName(undefined), langName(DEFAULT_LANG))
assert.match(outputLangClause('en'), /in English\.$/)

// The frontend and the backend must default to the SAME language, or a first-time visitor gets a
// UI in one language and AI output in another. nuxt.config is the frontend half.
const nuxtConfig = readFileSync(join(import.meta.dirname, '..', 'nuxt.config.ts'), 'utf8')
for (const key of ['defaultLocale', 'fallbackLocale']) {
  const m = nuxtConfig.match(new RegExp(`${key}:\\s*'([a-z-]+)'`))
  assert.ok(m, `nuxt.config.ts should set ${key}`)
  assert.equal(resolveLang(m![1]), DEFAULT_LANG, `nuxt.config ${key} ('${m![1]}') must match DEFAULT_LANG ('${DEFAULT_LANG}')`)
}
// Unattended automation has no request to read a cookie from, so its fallback must agree too.
const automationDefault = nuxtConfig.match(/automationLang:\s*process\.env\.AUTOMATION_LANG\s*\|\|\s*'([a-z-]+)'/)
assert.ok(automationDefault, 'nuxt.config.ts should set automationLang')
assert.equal(resolveLang(automationDefault![1]), DEFAULT_LANG, 'automationLang default must match DEFAULT_LANG')

// No call site may re-invent its own language default — private `lang || 'xx'` fallbacks are
// exactly how the frontend and the backend drifted apart. Everything must route through resolveLang.
const root = join(import.meta.dirname, '..')
const sources = execFileSync('git', ['ls-files', 'core', 'server', 'app'], { cwd: root, encoding: 'utf8' })
  .trim().split('\n').filter((f) => /\.(ts|vue|mjs)$/.test(f))
for (const rel of sources) {
  if (rel === 'core/agent/lang.ts') continue // the one place the default is allowed to live
  const src = readFileSync(join(root, rel), 'utf8')
  const bad = src.match(/\blang\w*\s*\|\|\s*'(zh|en|fr)'/i)
  assert.equal(bad, null, `${rel}: private language default ${bad?.[0]} — use resolveLang() instead`)
}

// Why pickByLang exists: French must no longer fall into the "not English, so Chinese" binary.
const table = { zh: '中', en: 'EN', fr: 'FR' }
assert.equal(pickByLang('fr', table), 'FR')
assert.equal(pickByLang('fr-FR', table), 'FR')
assert.equal(pickByLang('en', table), 'EN')
assert.equal(pickByLang(undefined, table), table[DEFAULT_LANG])

// ── Skill lint: both the rules and the negation exemptions must cover all three languages ──
// Skill body language follows the UI locale, so a boundary statement in the English/French methodology must not be treated as "workflow pollution".
for (const boundary of [
  '绝不执行 git push，只审不改。',
  'Never run `git push` — the engine controls that.',
  'Do not commit and push from the review agent.',
  'Ne jamais exécuter `git commit` depuis l’agent de revue.',
]) {
  assert.deepEqual(lintSkill(boundary), [], `boundary statement should not warn: ${boundary}`)
}

// Real pollution must be caught in all three languages.
for (const polluted of [
  '发现问题顺手改掉',
  'While you’re at it, fix the bug in the same pass.',
  'Corriger le bug au passage.',
]) {
  assert.deepEqual(lintSkill(polluted), ['疑似要求"顺手修复/改代码"（应只审不改）'], `should warn: ${polluted}`)
}
for (const polluted of [
  '跳过 worktree，直接在 main 分支审',
  'Skip the worktree and review directly on the main branch.',
  'Travailler sans worktree, directement sur la branche main.',
]) {
  assert.deepEqual(lintSkill(polluted), ['疑似要求跳过 worktree 隔离'], `should warn: ${polluted}`)
}

// Language-independent rules are unaffected.
assert.deepEqual(lintSkill('run git commit -m "wip"'), ['提到 git 写操作'])
assert.deepEqual(lintSkill('gh pr merge the branch when done'), ['提到 gh 写操作（发评论/合并/改 PR）'])

console.log('working-lang: ok')

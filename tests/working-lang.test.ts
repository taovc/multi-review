import assert from 'node:assert/strict'
import { langName, outputLangClause, pickByLang, resolveLang } from '../core/agent/lang'
import { lintSkill } from '../core/skillLint'

// ── Working-language normalization: the whole repo has this single entry point, unknown/missing always falls back to zh (matching the `|| 'zh'` in every endpoint) ──
assert.equal(resolveLang('zh'), 'zh')
assert.equal(resolveLang('en'), 'en')
assert.equal(resolveLang('fr'), 'fr')
assert.equal(resolveLang('fr-FR'), 'fr')
assert.equal(resolveLang('EN-us'), 'en')
assert.equal(resolveLang('de'), 'zh')
assert.equal(resolveLang(''), 'zh')
assert.equal(resolveLang(null), 'zh')
assert.equal(resolveLang(undefined), 'zh')

assert.equal(langName('fr-FR'), 'French')
assert.equal(langName(undefined), 'Chinese')
assert.match(outputLangClause('en'), /in English\.$/)

// Why pickByLang exists: French must no longer fall into the "not English, so Chinese" binary.
const table = { zh: '中', en: 'EN', fr: 'FR' }
assert.equal(pickByLang('fr', table), 'FR')
assert.equal(pickByLang('fr-FR', table), 'FR')
assert.equal(pickByLang('en', table), 'EN')
assert.equal(pickByLang(undefined, table), '中')

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

import assert from 'node:assert/strict'
import { langName, outputLangClause, pickByLang, resolveLang } from '../core/agent/lang'
import { lintSkill } from '../core/skillLint'

// ── 工作语言归一化：全仓只有这一个入口，未知/缺省一律落 zh（与所有端点的 `|| 'zh'` 一致）──
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

// pickByLang 存在的理由：法语不能再掉进「不是英文就中文」的二分里。
const table = { zh: '中', en: 'EN', fr: 'FR' }
assert.equal(pickByLang('fr', table), 'FR')
assert.equal(pickByLang('fr-FR', table), 'FR')
assert.equal(pickByLang('en', table), 'EN')
assert.equal(pickByLang(undefined, table), '中')

// ── skill 体检：规则和否定豁免都要覆盖三种语言 ──
// 技能正文语言跟 UI locale 走，所以英文/法文方法学里的边界声明不能被当成「操作流程污染」。
for (const boundary of [
  '绝不执行 git push，只审不改。',
  'Never run `git push` — the engine controls that.',
  'Do not commit and push from the review agent.',
  'Ne jamais exécuter `git commit` depuis l’agent de revue.',
]) {
  assert.deepEqual(lintSkill(boundary), [], `边界声明不该报警: ${boundary}`)
}

// 真正的污染，三种语言都要被抓出来。
for (const polluted of [
  '发现问题顺手改掉',
  'While you’re at it, fix the bug in the same pass.',
  'Corriger le bug au passage.',
]) {
  assert.deepEqual(lintSkill(polluted), ['疑似要求"顺手修复/改代码"（应只审不改）'], `应报警: ${polluted}`)
}
for (const polluted of [
  '跳过 worktree，直接在 main 分支审',
  'Skip the worktree and review directly on the main branch.',
  'Travailler sans worktree, directement sur la branche main.',
]) {
  assert.deepEqual(lintSkill(polluted), ['疑似要求跳过 worktree 隔离'], `应报警: ${polluted}`)
}

// 与语言无关的规则不受影响。
assert.deepEqual(lintSkill('run git commit -m "wip"'), ['提到 git 写操作'])
assert.deepEqual(lintSkill('gh pr merge the branch when done'), ['提到 gh 写操作（发评论/合并/改 PR）'])

console.log('working-lang: ok')

import assert from 'node:assert/strict'
import { buildSkillPrompt } from '../core/agent/skillgen'
import { langName, resolveLang } from '../core/agent/lang'

// 产出语言跟 UI locale 走（#16 工作语言）：断言锚在 langName() 的结果上，不锚提示词措辞，
// 这样重写提示词不会打红这条测试。
const directive = (lang: string) => new RegExp(`Write the entire methodology in ${langName(lang)}\\b`)

for (const lang of ['fr', 'en', 'zh']) {
  assert.match(buildSkillPrompt({ lang }), directive(lang))
}

// 不再硬编码中文：zh 之外的 locale 里，提示词不得出现「必须用中文」这类固定指令。
assert.doesNotMatch(buildSkillPrompt({ lang: 'fr' }), /Chinese/)
assert.doesNotMatch(buildSkillPrompt({ lang: 'en' }), /Chinese/)

// 完整 locale 码（如 fr-FR）也应正确解析。
assert.match(buildSkillPrompt({ lang: 'fr-FR' }), directive('fr'))

// 缺省（无 lang）→ 与其它 core agent 及所有端点一致，落到中文，而不是静默变英文。
assert.equal(resolveLang(undefined), 'zh')
assert.equal(resolveLang('de'), 'zh')
assert.match(buildSkillPrompt({}), directive('zh'))

// 优化路径：base 内容注入 + 语言指令并存。
const optimize = buildSkillPrompt({ lang: 'fr', baseContent: '# Old skill' })
assert.match(optimize, directive('fr'))
assert.match(optimize, /# Old skill/)

console.log('skillgen-lang: ok')

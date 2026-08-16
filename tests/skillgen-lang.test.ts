import assert from 'node:assert/strict'
import { buildSkillPrompt } from '../core/agent/skillgen'

// 产出语言跟 UI locale 走：buildSkillPrompt 应把方法学正文语言指令绑到 lang（#16 工作语言）。
const fr = buildSkillPrompt({ lang: 'fr' })
assert.match(fr, /用French撰写整套方法学/)
assert.doesNotMatch(fr, /- 中文\n/) // 不再硬编码中文

const en = buildSkillPrompt({ lang: 'en' })
assert.match(en, /用English撰写整套方法学/)

const zh = buildSkillPrompt({ lang: 'zh' })
assert.match(zh, /用Chinese撰写整套方法学/)

// 缺省（无 lang）→ 回落英文（langName 的默认），绝不再默认中文正文。
const none = buildSkillPrompt({})
assert.match(none, /用English撰写整套方法学/)

// 完整 locale 码（如 fr-FR）也应正确解析。
const frFR = buildSkillPrompt({ lang: 'fr-FR' })
assert.match(frFR, /用French撰写整套方法学/)

// 优化路径：base 内容注入 + 语言指令并存。
const optimize = buildSkillPrompt({ lang: 'fr', baseContent: '# Old skill' })
assert.match(optimize, /用French撰写整套方法学/)
assert.match(optimize, /# Old skill/)

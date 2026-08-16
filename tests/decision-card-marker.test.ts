import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RECOMMENDED_MARKER, stripRecommendedMarker } from '../core/agent/decisionCard'
import { askUserClause } from '../core/agent/chat'
import { buildCodexChatPrompt, buildCodexFeaturePrompt } from '../core/agent/codexChat'

// 决策卡的推荐标记是「提示词写出 → 前端剥掉」的一对协议。两边必须来自同一个常量，
// 否则改了一边就会把标记原样发回给 agent、或者按钮上一直挂着标记。
const root = join(import.meta.dirname, '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')

// 1) 所有提示词里的标记都来自共享常量，没有人再写死字面量。
for (const f of ['core/agent/chat.ts', 'core/agent/codexChat.ts']) {
  assert.doesNotMatch(read(f), /[（(]\s*推荐\s*[)）]/, `${f}: 提示词里不应再出现写死的中文推荐标记`)
  assert.doesNotMatch(read(f), /[（(]\s*recommended\s*[)）]/i, `${f}: 推荐标记应通过 RECOMMENDED_MARKER 插值，不要写死`)
}

// 2) 三个消费方都走共享的剥离函数，没有人再自带正则。
for (const f of ['app/components/FeatureDrawer.vue', 'app/components/FixPanel.vue', 'app/components/GlobalChat.vue']) {
  const src = read(f)
  assert.match(src, /stripRecommendedMarker\(/, `${f}: 应调用共享的 stripRecommendedMarker`)
  assert.doesNotMatch(src, /推荐\s*\[?\)）\]?/, `${f}: 不应再自带匹配中文标记的正则`)
}

// 3) 提示词确实把标记教给了 agent。
for (const prompt of [
  askUserClause('zh'),
  buildCodexFeaturePrompt({ cwd: '/tmp/p', model: '', lang: 'zh', sessionId: null, message: 'x', promptKind: 'feature', baseBranch: 'dev', ultracode: true }),
  buildCodexChatPrompt({ cwd: '/tmp/p', model: '', lang: 'zh', sessionId: null, message: 'x', ultracode: true }),
]) {
  assert.ok(prompt.includes(RECOMMENDED_MARKER), '提示词应包含推荐标记')
}

// 4) 剥离要兼容新旧两种标记和两种括号；非结尾出现的同名文字不能误伤。
assert.equal(stripRecommendedMarker('用方案 B (recommended)'), '用方案 B')
assert.equal(stripRecommendedMarker('用方案 B（recommended）'), '用方案 B')
assert.equal(stripRecommendedMarker('用方案 B (推荐)'), '用方案 B')
assert.equal(stripRecommendedMarker('用方案 B（推荐）'), '用方案 B')
assert.equal(stripRecommendedMarker('Option B (Recommended)'), 'Option B')
assert.equal(stripRecommendedMarker('用方案 B'), '用方案 B')
assert.equal(stripRecommendedMarker('把 (推荐) 写进标题里的方案'), '把 (推荐) 写进标题里的方案')

console.log('decision-card-marker: ok')

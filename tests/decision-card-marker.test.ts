import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RECOMMENDED_MARKER, stripRecommendedMarker } from '../core/agent/decisionCard'
import { askUserClause } from '../core/agent/chat'
import { codexUltracodePrompt } from '../core/codex/prompts'

// The decision card's recommended marker is a two-sided protocol: the prompt emits it, the frontend
// strips it. Both sides must come from the same constant, otherwise changing one side sends the marker
// straight back to the agent, or leaves it stuck on the button.
const root = join(import.meta.dirname, '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')

// 1) Every marker in the prompts comes from the shared constant; nobody hardcodes the literal anymore.
for (const f of ['core/agent/chat.ts', 'core/codex/prompts.ts']) {
  assert.doesNotMatch(read(f), /[（(]\s*推荐\s*[)）]/, `${f}: the prompts should no longer contain a hardcoded Chinese recommended marker`)
  assert.doesNotMatch(read(f), /[（(]\s*recommended\s*[)）]/i, `${f}: the recommended marker should be interpolated via RECOMMENDED_MARKER, not hardcoded`)
}

// 2) All three consumers use the shared stripping function; nobody carries their own regex anymore.
for (const f of ['app/components/FeatureDrawer.vue', 'app/components/FixPanel.vue', 'app/components/GlobalChat.vue']) {
  const src = read(f)
  assert.match(src, /stripRecommendedMarker\(/, `${f}: should call the shared stripRecommendedMarker`)
  assert.doesNotMatch(src, /推荐\s*\[?\)）\]?/, `${f}: should no longer carry its own regex matching the Chinese marker`)
}

// 3) The prompts really do teach the marker to the agent.
for (const prompt of [
  askUserClause('zh'),
  codexUltracodePrompt('feature'), // Codex fix/global sessions get the marker through askUserClause in their developer instructions
]) {
  assert.ok(prompt.includes(RECOMMENDED_MARKER), 'the prompt should contain the recommended marker')
}

// 4) Stripping must handle both the new and old marker and both bracket styles; the same wording
// appearing anywhere but the end must not be touched.
assert.equal(stripRecommendedMarker('用方案 B (recommended)'), '用方案 B')
assert.equal(stripRecommendedMarker('用方案 B（recommended）'), '用方案 B')
assert.equal(stripRecommendedMarker('用方案 B (推荐)'), '用方案 B')
assert.equal(stripRecommendedMarker('用方案 B（推荐）'), '用方案 B')
assert.equal(stripRecommendedMarker('Option B (Recommended)'), 'Option B')
assert.equal(stripRecommendedMarker('用方案 B'), '用方案 B')
assert.equal(stripRecommendedMarker('把 (推荐) 写进标题里的方案'), '把 (推荐) 写进标题里的方案')

console.log('decision-card-marker: ok')

import assert from 'node:assert/strict'
import { codexUltracodeEffort, parseCodexModels } from '../core/agent/codexModels'

const models = parseCodexModels(JSON.stringify({
  models: [
    {
      slug: 'gpt-5.5',
      display_name: 'GPT-5.5',
      description: 'Previous model',
      visibility: 'list',
      priority: 7,
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'xhigh' }],
    },
    {
      slug: 'gpt-5.6-terra',
      display_name: 'GPT-5.6-Terra',
      description: 'Current balanced model',
      visibility: 'list',
      priority: 2,
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'max' }, { effort: 'ultra' }],
    },
    {
      slug: 'gpt-5.6-luna',
      display_name: 'GPT-5.6-Luna',
      visibility: 'list',
      priority: 3,
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'max' }],
    },
    {
      slug: 'hidden-model',
      display_name: 'Hidden',
      visibility: 'hide',
      priority: 0,
      supported_reasoning_levels: [{ effort: 'ultra' }],
    },
  ],
}))

assert.deepEqual(models.map((model) => model.value), ['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'])
assert.deepEqual(models[0]?.effortLevels, ['low', 'max', 'ultra'])
assert.equal(codexUltracodeEffort(models, 'gpt-5.6-terra'), 'ultra')
assert.equal(codexUltracodeEffort(models, 'gpt-5.6-luna'), 'xhigh')
assert.equal(codexUltracodeEffort(models, 'missing-model'), 'xhigh')
assert.equal(codexUltracodeEffort(models), 'ultra')

const solModels = parseCodexModels(JSON.stringify({
  models: [{
    slug: 'gpt-5.6-sol',
    display_name: 'GPT-5.6-Sol',
    visibility: 'list',
    priority: 1,
    supported_reasoning_levels: [{ effort: 'ultra' }],
  }],
}))
assert.equal(codexUltracodeEffort(solModels, 'gpt-5.6'), 'ultra')
assert.deepEqual(parseCodexModels('not-json'), [])

import assert from 'node:assert/strict'
import { classifyCommands, codexSkillEntries, filterCommands, matchesPrefix, CURATED_BUILTINS } from '../core/host/commands'

// The "/" palette catalogue: classification (user skill / plugin / built-in, curated vs hidden) and PREFIX matching
// on names, namespace segments and aliases.
const entries = classifyCommands([
  { name: 'grilling', description: 'Grill the user relentlessly (user)', argumentHint: '' },
  { name: 'speckit.plan', description: 'Execute the planning workflow (project)', argumentHint: '<feature>' },
  { name: 'Notion:tasks:plan', description: 'Plan tasks in Notion', argumentHint: '' },
  { name: 'mcp__plugin_Notion_notion__make-this-a-notion-page', description: 'Turn this into a Notion page', argumentHint: '' },
  { name: 'compact', description: 'Compact the conversation', argumentHint: '' },
  { name: 'plugin:Notion:notion:make-this-a-notion-page (MCP)', description: 'MCP prompt', argumentHint: '' },
  { name: 'usage', description: 'Show usage', argumentHint: '', aliases: ['cost', 'stats'] },
  { name: 'vim', description: 'Toggle vim mode', argumentHint: '' },
  { name: 'exit', description: 'Exit', argumentHint: '' },
  { name: 'doctor', description: 'Diagnose', argumentHint: '' },
  { name: 'compact', description: 'duplicate', argumentHint: '' },
])
const byName = Object.fromEntries(entries.map((e) => [e.name, e]))

assert.equal(byName['grilling']!.origin, 'user')
assert.equal(byName['grilling']!.description, 'Grill the user relentlessly') // the CLI's "(user)" suffix is stripped
assert.equal(byName['speckit.plan']!.origin, 'user')
assert.equal(byName['Notion:tasks:plan']!.origin, 'plugin')
assert.equal(byName['Notion:tasks:plan']!.plugin, 'Notion')
assert.equal(byName['Notion:tasks:plan']!.shortName, 'tasks:plan')
assert.equal(byName['mcp__plugin_Notion_notion__make-this-a-notion-page']!.plugin, 'Notion')
assert.equal(byName['mcp__plugin_Notion_notion__make-this-a-notion-page']!.shortName, 'make-this-a-notion-page')
assert.equal(byName['plugin:Notion:notion:make-this-a-notion-page']!.plugin, 'Notion') // " (MCP)" suffix stripped, plugin parsed past the 'plugin:' prefix
assert.equal(byName['plugin:Notion:notion:make-this-a-notion-page']!.shortName, 'notion:make-this-a-notion-page')
assert.equal(byName['compact']!.origin, 'builtin')
assert.equal(byName['compact']!.curated, true)
assert.equal(byName['vim'], undefined) // hidden outright
assert.equal(byName['exit'], undefined)
assert.equal(byName['doctor'], undefined)
assert.equal(entries.filter((e) => e.name === 'compact').length, 1) // de-duplicated
assert.ok(CURATED_BUILTINS.has('usage'))

// Prefix semantics: name, any segment, aliases — never substring.
assert.equal(matchesPrefix(byName['speckit.plan']!, 'plan'), true)
assert.equal(matchesPrefix(byName['Notion:tasks:plan']!, 'plan'), true)
assert.equal(matchesPrefix(byName['Notion:tasks:plan']!, 'tasks'), true)
assert.equal(matchesPrefix(byName['Notion:tasks:plan']!, 'asks'), false)
assert.equal(matchesPrefix(byName['usage']!, 'cos'), true) // alias /cost
assert.equal(matchesPrefix(byName['grilling']!, 'gri'), true)
assert.equal(matchesPrefix(byName['grilling']!, 'rill'), false)
assert.equal(matchesPrefix(byName['mcp__plugin_Notion_notion__make-this-a-notion-page']!, 'make'), true)

// Curated by default; built-ins outside the curated set need "show all".
const hiddenBuiltin = classifyCommands([{ name: 'statusline-config', description: 'x', argumentHint: '' }])[0]!
assert.equal(hiddenBuiltin.curated, false)
assert.deepEqual(filterCommands([hiddenBuiltin, byName['compact']!], '', false).map((e) => e.name), ['compact'])
assert.deepEqual(filterCommands([hiddenBuiltin, byName['compact']!], '', true).map((e) => e.name), ['statusline-config', 'compact'])

// Codex skills become entries with their path (the host turns "/name args" into a skill input item).
const cx = codexSkillEntries([{ name: 'pdf', description: 'Read PDFs', path: '/skills/pdf', enabled: true }, { name: 'off', description: '', path: '/x', enabled: false }])
assert.deepEqual(cx.map((e) => [e.name, e.origin, e.path]), [['pdf', 'codex-skill', '/skills/pdf']])
console.log('host-commands: ok')

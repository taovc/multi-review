import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import { probeAgent } from '../core/host/config'

// MANUAL probe (not in the test glob): starts the real Claude CLI once with the user's configuration and checks
// that the session host really loads it — enabled plugins expose commands, Claude in Chrome and the claude.ai
// connectors report a status, the memory files include the global and the cwd CLAUDE.md.
//   pnpm exec tsx tests/host-config.probe.ts [cwd]
const cwd = process.argv[2] || process.cwd()
const t0 = Date.now()
const report = await probeAgent(cwd, true, true)
const names = (xs: Array<{ name: string }>) => xs.map((x) => x.name)

console.log(`probe ${report.at} in ${report.ms} ms (${Date.now() - t0} ms wall)`)
console.log('commands:', report.commands.length, '· agents:', report.agents.length, '· chrome:', report.chromeTransport, '· mcp:', names(report.mcp).join(', '))
if (report.error) console.log('error:', report.error)

assert.ok(report.commands.length > 20, 'the CLI should report its built-in and user commands')
const pluginCommands = report.commands.filter((c) => c.origin === 'plugin' || c.name.includes(':'))
assert.ok(pluginCommands.length > 0, `enabled plugins should contribute namespaced commands (got ${report.commands.length} commands, none namespaced)`)
const chrome = report.mcp.find((s) => s.name === 'claude-in-chrome')
assert.ok(chrome, 'claude-in-chrome should be listed when the probe passes --chrome')
assert.ok(['connected', 'needs-auth', 'pending', 'failed'].includes(chrome!.status), `claude-in-chrome status ${chrome!.status}`)
for (const s of report.mcp.filter((x) => x.name.startsWith('claude.ai'))) assert.ok(['connected', 'needs-auth', 'pending', 'failed'].includes(s.status), `${s.name}: ${s.status}`)
const memory = report.context.filter((c) => /memory|claude\.md/i.test(c.name))
if (existsSync(join(os.homedir(), '.claude', 'CLAUDE.md'))) assert.ok(memory.length > 0, 'the startup context should include memory files when ~/.claude/CLAUDE.md exists')
console.log('probe ok')

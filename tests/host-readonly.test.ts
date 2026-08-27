import assert from 'node:assert/strict'
import { reviewVerdict, makeReviewGuardHook, makeReviewCanUseTool, REVIEW_DENY_RULES } from '../core/host/readonly'
import { buildReviewOptions, buildHelperOptions, projectDirNameFor, projectMcpServerNames } from '../core/host/options'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Layer 1 + 3 decision function
assert.equal(reviewVerdict('Read', { file_path: '/x' }, false).ok, true)
assert.equal(reviewVerdict('Bash', { command: 'git diff origin/main...HEAD' }, false).ok, true)
assert.equal(reviewVerdict('Bash', { command: 'git push origin HEAD' }, false).ok, false)
assert.equal(reviewVerdict('Bash', { command: 'git -C /w --no-pager commit -m x' }, false).ok, false)
assert.equal(reviewVerdict('Bash', { command: 'cd /w && git push' }, false).ok, false)
assert.equal(reviewVerdict('Bash', { command: 'gh api -X POST repos/x/y/issues' }, false).ok, false)
assert.equal(reviewVerdict('Bash', { command: 'gh pr view 12 --json title' }, false).ok, true)
assert.equal(reviewVerdict('Write', { file_path: '/x' }, false).ok, false)
assert.equal(reviewVerdict('Edit', {}, false).ok, false)
assert.equal(reviewVerdict('WebFetch', {}, false).ok, false)
assert.equal(reviewVerdict('mcp__plugin_Notion_notion__notion-search', {}, false).ok, false)
assert.equal(reviewVerdict('mcp__plugin_Notion_notion__notion-search', {}, true).ok, true)
assert.equal(reviewVerdict('ListMcpResourcesTool', { server: 'sentry' }, false).ok, false)
assert.equal(reviewVerdict('Write', { file_path: '/x' }, true).ok, false, 'MCP on does not loosen anything else')
assert.equal(reviewVerdict('Skill', { skill: 'grilling' }, false).ok, true)
// write primitives are blocked, harmless redirections are not
for (const c of ['touch a.txt', 'echo x > a.txt', 'cat a >> b', 'echo x 1> a.txt', 'cmd &> a.txt', 'sed -i "s/a/b/" f', 'mkdir -p x', 'mv a b', 'cp a b', 'tee out.txt', 'rm a.txt', 'ls; rm -r x', 'ls && sudo id', 'pnpm install', 'npm i lodash', 'python3 -c "open(\'x\',\'w\')"', 'node -e "require(\'fs\').writeFileSync(1,1)"', 'node <<EOF\nx\nEOF', 'find . -name x -exec rm {} \\;', 'find . -delete', 'ls | xargs rm', 'gh api repos/o/r/issues -f title=x', 'gh api graphql -f query="mutation { x }"', 'gh release upload v1 ./x.zip', 'osascript -e "tell app"', 'python3 -m http.server']) assert.equal(reviewVerdict('Bash', { command: c }, false).ok, false, c)
for (const c of ['git log --oneline -5 2>/dev/null', 'grep -rn foo . >/dev/null; echo $?', 'ls -la 2>&1 | head', 'git diff HEAD~1 -- src/patch.ts', 'rg "TODO" --glob "*.ts"', 'grep -rn "install" apps/web/package.json', 'sed -n 1,80p packages/cp/mv.ts', 'cat scripts/install.sh | head', 'git log -3 -- apps/web/rm-helper.ts', 'git log --oneline -5 -- src/commit-helper.ts', 'git show HEAD:docs/branch.md', 'gh api repos/o/r/pulls/1/files', 'node --version', 'python3 --version', 'grep -rn "=>" src | head', 'rg "a -> b" .', 'grep -n "x >= 1" f.ts', 'grep -rn "<>" .']) assert.equal(reviewVerdict('Bash', { command: c }, false).ok, true, c)

// Hook shape: deny carries the PreToolUse decision, allow leaves the normal permission flow untouched
const hook = makeReviewGuardHook(false)
const denied: any = await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf /' } } as any, 'tu1', { signal: new AbortController().signal })
assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny')
const passed: any = await hook({ hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'x' } } as any, 'tu2', { signal: new AbortController().signal })
assert.equal(passed.hookSpecificOutput, undefined)

// canUseTool mirrors the verdict
const cut = makeReviewCanUseTool(false)
assert.equal((await cut('Write', { file_path: '/x' }, { signal: new AbortController().signal } as any)).behavior, 'deny')
assert.equal((await cut('Read', { file_path: '/x' }, { signal: new AbortController().signal } as any)).behavior, 'allow')

// Option factories: user configuration loaded (no settingSources override), three layers present
const ro = buildReviewOptions({ cwd: '/tmp/wt', model: 'sonnet', methodology: 'M', maxTurns: 5, projectDirName: 'p' })
assert.deepEqual(ro.mcpServers, {}, 'MCP off → no MCP connections')
assert.equal(ro.extraArgs, undefined)
const withMcp = buildReviewOptions({ cwd: '/tmp/wt', methodology: 'M', maxTurns: 5, mcp: true, chrome: true })
assert.equal(withMcp.mcpServers, undefined)
assert.deepEqual(withMcp.extraArgs, { chrome: null }, 'MCP on + chrome → the CLI starts Claude in Chrome')
assert.equal(buildReviewOptions({ cwd: '/tmp/wt', methodology: 'M', maxTurns: 5, mcp: false, chrome: true }).extraArgs, undefined, 'chrome never without MCP')
// A PR branch that ships its own .mcp.json must not get those servers spawned by a review, even with MCP on.
const wt = mkdtempSync(join(tmpdir(), 'ro-wt-'))
writeFileSync(join(wt, '.mcp.json'), JSON.stringify({ mcpServers: { evil: { command: 'sh', args: ['-c', 'id'] }, other: { url: 'http://x' } } }))
assert.deepEqual(projectMcpServerNames(wt), ['evil', 'other'])
assert.deepEqual((buildReviewOptions({ cwd: wt, methodology: 'M', maxTurns: 5, mcp: true }).settings as any).disabledMcpjsonServers, ['evil', 'other'])
assert.equal((withMcp.settings as any).disabledMcpjsonServers, undefined, 'no .mcp.json → nothing to disable')
writeFileSync(join(wt, '.mcp.json'), '{not json')
assert.deepEqual(projectMcpServerNames(wt), ['*'], 'unreadable .mcp.json → refuse everything it could declare')
assert.equal(ro.settingSources, undefined)
assert.deepEqual((ro.systemPrompt as any), { type: 'preset', preset: 'claude_code', append: 'M' })
assert.equal(ro.permissionMode, 'default')
assert.ok(Array.isArray(ro.hooks?.PreToolUse) && ro.hooks!.PreToolUse!.length === 1)
assert.deepEqual((ro.settings as any).permissions.deny, REVIEW_DENY_RULES)
assert.equal((ro.settings as any).disableAllHooks, true)
assert.ok(ro.disallowedTools!.includes('Write'))
assert.equal((ro.env as any).CLAUDE_CODE_PROJECT_DIR_NAME, 'p')
const h = buildHelperOptions({ cwd: '/tmp/x', model: 'sonnet' })
assert.deepEqual(h.settingSources, [])
assert.deepEqual(h.tools, [])
assert.equal(h.maxTurns, 1)
assert.equal(h.persistSession, false)
assert.equal(projectDirNameFor('/Users/me/work/pr-cockpit'), '-Users-me-work-pr-cockpit')
assert.equal(projectDirNameFor(null), undefined)
console.log('host-readonly.test.ts ✓')

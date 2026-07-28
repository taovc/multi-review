import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codexCliConfig, codexWorkingDirectoryOptions, isForbiddenRemoteOrGitMutation, toCodexEffort } from '../core/agent/codexAgent'
import { buildCodexChatPrompt, buildCodexFeaturePrompt, buildCodexGlobalPrompt } from '../core/agent/codexChat'
import { shouldBlockCodexCommand } from '../core/agent/commandGuard'
import { projectGlobalAgentDefaults, runtimeGlobalAgentDefaults } from '../server/utils/globalAgentConfig'

assert.deepEqual(codexCliConfig({} as NodeJS.ProcessEnv), {
  project_doc_fallback_filenames: ['CLAUDE.md', '.claude/CLAUDE.md'],
  project_doc_max_bytes: 65536,
})

assert.deepEqual(codexCliConfig({
  CODEX_SERVICE_TIER: 'fast',
  CODEX_PROJECT_DOC_FALLBACK_FILENAMES: 'CLAUDE.md,docs/AI.md',
  CODEX_PROJECT_DOC_MAX_BYTES: '12345',
} as NodeJS.ProcessEnv), {
  project_doc_fallback_filenames: ['CLAUDE.md', 'docs/AI.md'],
  project_doc_max_bytes: 12345,
  service_tier: 'fast',
})

assert.equal('service_tier' in codexCliConfig({ CODEX_SERVICE_TIER: '' } as NodeJS.ProcessEnv), false)
assert.equal('service_tier' in codexCliConfig({ CODEX_SERVICE_TIER: '   ' } as NodeJS.ProcessEnv), false)
assert.equal('service_tier' in codexCliConfig({ CODEX_SERVICE_TIER: 'fast' } as NodeJS.ProcessEnv, { serviceTier: null }), false)
assert.equal(codexCliConfig({} as NodeJS.ProcessEnv, { serviceTier: 'fast' }).service_tier, 'fast')
assert.equal(codexCliConfig({} as NodeJS.ProcessEnv, { reasoningEffort: 'max' }).model_reasoning_effort, 'max')
assert.equal(codexCliConfig({} as NodeJS.ProcessEnv, { reasoningEffort: 'ultra' }).model_reasoning_effort, 'ultra')
assert.equal(toCodexEffort('max'), 'max')
assert.equal(toCodexEffort('ultra'), 'ultra')
assert.equal(toCodexEffort('not-a-real-effort'), undefined)
assert.equal(codexCliConfig({ CODEX_PROJECT_DOC_MAX_BYTES: 'nope' } as NodeJS.ProcessEnv).project_doc_max_bytes, 65536)
assert.deepEqual(codexWorkingDirectoryOptions(), { skipGitRepoCheck: true })
assert.deepEqual(codexWorkingDirectoryOptions(process.cwd()), { workingDirectory: process.cwd() })
const nonGitDir = mkdtempSync(join(tmpdir(), 'codex-non-git-'))
try {
  assert.deepEqual(codexWorkingDirectoryOptions(nonGitDir), { workingDirectory: nonGitDir, skipGitRepoCheck: true })
} finally {
  rmSync(nonGitDir, { recursive: true, force: true })
}

assert.deepEqual(runtimeGlobalAgentDefaults({ inferenceProvider: 'codex', codexModel: 'gpt-5', anthropicModel: 'claude-sonnet', globalEffort: 'high' }), {
  provider: 'codex',
  model: 'gpt-5',
  effort: 'high',
  codexServiceTier: null,
})
assert.deepEqual(projectGlobalAgentDefaults({ provider: 'codex', model: '', effort: 'xhigh', codexServiceTier: 'fast', localPath: '/tmp/project' }, { codexModel: 'gpt-5' }), {
  provider: 'codex',
  model: 'gpt-5',
  effort: 'xhigh',
  codexServiceTier: 'fast',
  cwd: '/tmp/project',
})
assert.deepEqual(projectGlobalAgentDefaults({ provider: 'claude', model: 'claude-opus', effort: '', codexServiceTier: 'fast' }, { anthropicModel: 'claude-sonnet' }), {
  provider: 'claude',
  model: 'claude-opus',
  effort: undefined,
  codexServiceTier: null,
})

const featurePrompt = buildCodexFeaturePrompt({
  cwd: '/tmp/project',
  model: '',
  lang: 'zh',
  sessionId: null,
  message: '实现一个导出按钮',
  promptKind: 'feature',
  baseBranch: 'dev',
  ultracode: true,
})
assert.match(featurePrompt, /```ask-user/)
assert.match(featurePrompt, /Ultracode mode is enabled/)
assert.match(featurePrompt, /git push -u origin HEAD/)
assert.match(featurePrompt, /gh pr create --base dev/)

const fixPrompt = buildCodexChatPrompt({
  cwd: '/tmp/project',
  model: '',
  lang: 'zh',
  sessionId: null,
  message: '修一下 reviewer 提到的问题',
  ultracode: true,
})
assert.match(fixPrompt, /Ultracode mode is enabled/)
assert.match(fixPrompt, /```ask-user/)

const globalPrompt = buildCodexGlobalPrompt({
  cwd: '/tmp/project',
  model: '',
  sessionId: null,
  message: '检查这个项目',
  ultracode: true,
})
assert.match(globalPrompt, /Codex thread/)
assert.match(globalPrompt, /Ultracode mode is enabled/)
assert.match(globalPrompt, /```ask-user/)

assert.equal(isForbiddenRemoteOrGitMutation('gh pr create --base dev --title test --body body'), true)
assert.equal(isForbiddenRemoteOrGitMutation('gh --repo owner/repo pr create --base dev --title test --body body'), true)
assert.equal(isForbiddenRemoteOrGitMutation('gh --repo owner/repo api repos/owner/repo/issues --method POST'), true)
assert.equal(isForbiddenRemoteOrGitMutation('/bin/zsh -lc \'git rev-parse HEAD origin/dev && git merge-base HEAD origin/dev\''), false)
assert.equal(isForbiddenRemoteOrGitMutation('git merge origin/dev'), true)
assert.equal(isForbiddenRemoteOrGitMutation('git merge-base HEAD origin/dev'), false)
assert.equal(isForbiddenRemoteOrGitMutation('git -C /tmp/repo merge origin/dev'), true)
assert.equal(isForbiddenRemoteOrGitMutation('git branch --show-current'), false)
assert.equal(isForbiddenRemoteOrGitMutation('git stash list'), false)
assert.equal(isForbiddenRemoteOrGitMutation('git worktree list'), false)
assert.equal(isForbiddenRemoteOrGitMutation('git tag --list'), false)
assert.equal(isForbiddenRemoteOrGitMutation('git branch fix-conflict'), true)
assert.equal(isForbiddenRemoteOrGitMutation('git merge origin/dev', { allowLocalGitMutation: true }), false)
assert.equal(isForbiddenRemoteOrGitMutation('git branch fix-conflict', { allowLocalGitMutation: true }), false)
assert.equal(isForbiddenRemoteOrGitMutation('git push origin HEAD', { allowLocalGitMutation: true }), true)
assert.equal(isForbiddenRemoteOrGitMutation('gh pr comment 1 --body ok', { allowLocalGitMutation: true }), true)
const featurePushWithChecks = "/bin/zsh -lc 'git status --short --branch && git log --oneline --decorate origin/dev..HEAD && git diff --stat origin/dev...HEAD && git push -u origin HEAD'"
const featureCommitWithChecks = "/bin/zsh -lc 'git add apps/web/i18n/en.json apps/web/i18n/fr.json && git diff --cached --check && git diff --cached --stat && git commit -m \"fix(web): deduplicate expired subscription toasts\"'"
const featureRebaseWithChecks = "/bin/zsh -lc 'git rebase origin/dev && git status --short --branch && git rev-list --left-right --count origin/dev...HEAD'"

// With dangerous commands enabled, the guard must not block local git, remote git, gh, or command chains.
assert.equal(shouldBlockCodexCommand(featureRebaseWithChecks, { scope: 'feature', allowDanger: true }), false)
assert.equal(shouldBlockCodexCommand(featurePushWithChecks, { scope: 'feature', allowDanger: true }), false)
assert.equal(shouldBlockCodexCommand(featureCommitWithChecks, { scope: 'feature', allowDanger: true }), false)
assert.equal(shouldBlockCodexCommand('git push origin main', { scope: 'feature', allowDanger: true }), false)
assert.equal(shouldBlockCodexCommand('gh pr merge 123', { scope: 'feature', allowDanger: true }), false)
assert.equal(shouldBlockCodexCommand('git push -u origin HEAD', { scope: 'fix', allowDanger: true }), false)
assert.equal(shouldBlockCodexCommand('gh api repos/owner/repo/issues/1 --method DELETE', { scope: 'readonly', allowDanger: true }), false)

// Without the flag, git/GitHub mutations remain blocked; global chat never attaches this guard.
assert.equal(shouldBlockCodexCommand(featureRebaseWithChecks, { scope: 'feature' }), true)
assert.equal(shouldBlockCodexCommand(featurePushWithChecks, { scope: 'feature' }), true)
assert.equal(shouldBlockCodexCommand(featureCommitWithChecks, { scope: 'feature' }), true)
assert.equal(shouldBlockCodexCommand('git push -u origin HEAD', { scope: 'fix' }), true)
assert.equal(shouldBlockCodexCommand('gh pr merge 123', { scope: 'readonly' }), true)
assert.equal(shouldBlockCodexCommand('git push -u origin HEAD', { scope: 'global' }), false)

import assert from 'node:assert/strict'
import { codexCliConfig, isForbiddenRemoteOrGitMutation } from '../core/agent/codexAgent'
import { buildCodexChatPrompt, buildCodexFeaturePrompt, buildCodexGlobalPrompt, isAllowedFeaturePublishCommand } from '../core/agent/codexChat'
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
assert.equal(codexCliConfig({ CODEX_PROJECT_DOC_MAX_BYTES: 'nope' } as NodeJS.ProcessEnv).project_doc_max_bytes, 65536)

assert.deepEqual(runtimeGlobalAgentDefaults({ inferenceProvider: 'codex', codexModel: 'gpt-5', anthropicModel: 'claude-sonnet', globalEffort: 'high' }), {
  provider: 'codex',
  model: 'gpt-5',
  effort: 'high',
  codexServiceTier: null,
})
assert.deepEqual(projectGlobalAgentDefaults({ provider: 'codex', model: '', effort: 'xhigh', codexServiceTier: 'fast' }, { codexModel: 'gpt-5' }), {
  provider: 'codex',
  model: 'gpt-5',
  effort: 'xhigh',
  codexServiceTier: 'fast',
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
assert.equal(isAllowedFeaturePublishCommand('git push -u origin HEAD'), true)
assert.equal(isAllowedFeaturePublishCommand('git push --set-upstream origin HEAD'), true)
assert.equal(isAllowedFeaturePublishCommand('git add . && git commit -m "feat: add export" && git push -u origin HEAD && gh pr create --base dev --title Export --body Done'), true)
assert.equal(isAllowedFeaturePublishCommand('git push origin main'), false)
assert.equal(isAllowedFeaturePublishCommand('git push -u origin main && git push origin HEAD'), false)
assert.equal(isAllowedFeaturePublishCommand('git add . && git push origin main'), false)
assert.equal(isAllowedFeaturePublishCommand('gh pr create --body "$(cat /tmp/body.md)"'), false)
assert.equal(isAllowedFeaturePublishCommand('gh pr merge 123'), false)

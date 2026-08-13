import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { claudeChatRunner } from '../core/agent/claudeRunners'
import { runFixChatJob } from '../core/fix/pipeline'
import * as schema from '../core/db/schema'
import type { FixJobCtx } from '../core/fix/pipeline'
import type { FixChatOptions } from '../core/agent/fixer'

const wt = mkdtempSync(path.join(tmpdir(), 'pr-cockpit-chat-error-'))

const fixRow: Record<string, any> = {
  id: 'fix-1',
  projectId: 'project-1',
  prNumber: 34,
  branch: 'feature-branch',
  defaultBranch: 'main',
  status: 'ready',
  worktreePath: wt,
  baseHeadSha: 'base-sha',
  sessionId: 'claude-session',
  pushedAt: null,
}
const turns: Record<string, any>[] = []
const events: Record<string, any>[] = []

const fakeDb = {
  select: () => ({
    from: (table: unknown) => ({
      where: () => ({
        get: () => (table === schema.fixes ? fixRow : undefined),
        all: () => (table === schema.fixTurns ? turns : []),
      }),
    }),
  }),
  insert: (table: unknown) => ({
    values: (value: Record<string, any>) => ({
      run: () => {
        if (table === schema.fixTurns) turns.push({ ...value })
        if (table === schema.fixEvents) events.push({ ...value })
        return { changes: 1 }
      },
    }),
  }),
  update: (table: unknown) => ({
    set: (patch: Record<string, any>) => ({
      where: () => ({
        run: () => {
          if (table === schema.fixes) Object.assign(fixRow, patch)
          if (table === schema.fixTurns) Object.assign(turns[turns.length - 1]!, patch)
          return { changes: 1 }
        },
      }),
    }),
  }),
}

const ctx: FixJobCtx = {
  db: fakeDb,
  schema,
  fixId: 'fix-1',
  repo: 'taovc/pr-cockpit',
  prNumber: 34,
  branch: 'feature-branch',
  defaultBranch: 'main',
  localPath: wt,
  reposDir: path.dirname(wt),
  provider: 'claude',
  model: 'sonnet',
  lang: 'zh',
}

const originalRunChat = claudeChatRunner.runChat
claudeChatRunner.runChat = async (_opts: FixChatOptions) => {
  throw new Error('claude runtime failed')
}

try {
  await runFixChatJob(ctx, 'please fix it')
} finally {
  claudeChatRunner.runChat = originalRunChat
  rmSync(wt, { recursive: true, force: true })
}

// 统一行为（不分 provider）：聊天轮真出错 → fix 标 error + 错误信息落库 + 该轮 error。
assert.equal(fixRow.status, 'error')
assert.equal(fixRow.error, 'claude runtime failed')
assert.equal(turns.at(-1)?.status, 'error')

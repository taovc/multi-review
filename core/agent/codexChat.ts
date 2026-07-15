import { type ThreadEvent, type ThreadOptions } from '@openai/codex-sdk'
import { classifyCodexError, extractCodexErrorMessage, formatCodexProviderError } from './codexErrors'
import { codexWorkingDirectoryOptions, newCodex, toCodexEffort } from './codexAgent'
import { codexUltracodeEffort, getCodexModels } from './codexModels'
import { shouldBlockCodexCommand, type CodexCommandGuardScope } from './commandGuard'
import { outputLangClause } from './lang'
import { askUserClause } from './chat'
import type { ChatRunner } from './runners'
import type { FixChatOptions, FixChatResult } from './fixer'

export { isAllowedFeaturePublishCommand } from './commandGuard'

export class CodexChatError extends Error {
  override cause?: unknown

  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'CodexChatError'
    this.cause = cause
  }
}

export function normalizeCodexChatError(error: unknown): CodexChatError {
  if (error instanceof CodexChatError) return error
  return new CodexChatError(formatCodexProviderError('chat', error), error)
}

export function shouldRetryCodexChatWithoutThread(error: unknown, hadSessionId: boolean): boolean {
  return hadSessionId && classifyCodexError(error) === 'invalid_thread'
}

function codexUltracodePrompt(kind: 'fix' | 'feature' | 'global'): string {
  const askUser = kind === 'feature'
    ? `- Ask ONLY on genuine decision points: architecture, data model, external contract, or a real user-facing tradeoff. When you must ask, STOP and emit exactly one fenced block, then end the turn:
\`\`\`ask-user
<your question in one or two lines>
- <option A>
- <option B (推荐)>
\`\`\`
  Mark the recommended option with (推荐).`
    : '- If you hit a real blocker or need a product decision, stop and state the exact question clearly; do not invent requirements.'

  return `Ultracode mode is enabled for this Codex turn.
- Use deep reasoning and a deliberate implementation workflow: inspect the relevant project docs first, then read the actual code before editing.
- Keep a concise internal todo list for multi-step work, but keep the final reply brief.
- Prefer the smallest complete, reviewable slice over broad rewrites.
- Verify with targeted tests or checks when practical; if you cannot run them, say exactly why.
${askUser}`
}

export function buildCodexChatPrompt(opts: FixChatOptions): string {
  if (opts.promptKind === 'feature') return buildCodexFeaturePrompt(opts)
  if (opts.promptKind === 'global') return buildCodexGlobalPrompt(opts)
  const opening = opts.sessionId
    ? 'You are continuing the same Codex thread for this pull-request fix task in the same git worktree.'
    : 'You are starting a Codex chat for this pull-request fix task in a git worktree.'

  return `${opening}
${opts.conflictHint ? '\n' + opts.conflictHint + '\n' : ''}
This is a CONVERSATION, not a fresh review. Treat the reviewer's message below as the primary instruction and respond to exactly what they asked.

- If they ask a question or discuss the change, answer from context without proactively re-reviewing the whole PR.
- Only investigate when the message asks you to check, re-verify, confirm, or look into something.
- If they ask for a code change, edit files directly in this workspace; keep changes minimal and on-topic.
- Do NOT push, post comments, reply to GitHub, or mutate any remote service.
- Do NOT run git add, git commit, git push, gh pr review/comment/merge, or gh api mutations.
- Leave edits unstaged and uncommitted. The Node process will inspect the diff, commit it, and update fixHeadSha.
${opts.historyAccess ? `\n${opts.historyAccess}` : ''}
${opts.ultracode ? `\n${codexUltracodePrompt('fix')}` : ''}

Reviewer's message:
${opts.message}

Reply briefly: answer their question, or describe what you changed. ${outputLangClause(opts.lang)}

${askUserClause(opts.lang)}`
}

// Feature 开发：在「从默认分支拉的新功能分支」worktree 里自由开发（不是修 PR）。
export function buildCodexFeaturePrompt(opts: FixChatOptions): string {
  const opening = opts.sessionId
    ? 'You are continuing the same Codex thread, building a feature inside its isolated git worktree.'
    : 'You are starting a Codex chat to build a NEW feature inside an isolated git worktree on a fresh feature branch (created from the default branch).'
  const base = opts.baseBranch || 'the default branch'

  return `${opening}

The current directory is that worktree — implement what the user asks by editing files directly. Investigate the repo whenever it helps. Keep the change a focused, reviewable slice.

Working principles:
- Explore before acting: read the relevant code first, reuse existing patterns/conventions, and keep each change a small, focused, reviewable slice. If the request is too big, propose the smallest first slice.
- Just do it when it's clear: if the change is unambiguous with no real fork, implement it directly.
- Ask ONLY on genuine decision points (architecture / data model / external contract / a real user-facing tradeoff). When you must ask, STOP and emit EXACTLY one fenced block, then END your turn and wait (the user's answer arrives as the next message):
\`\`\`ask-user
<your question in one or two lines>
- <option A>
- <option B (推荐)>
\`\`\`
  Mark your recommended option with (推荐). Batch related questions; never ask about implementation details you can decide yourself; keep the number of questions minimal.
- Do NOT commit or push by default — leave your edits uncommitted in the worktree. EXCEPTION: when the user explicitly asks you to open a PR (e.g. "开 PR" / "open a PR"), then: commit with an English conventional-commit message; push the current branch with \`git push -u origin HEAD\` (NEVER a bare \`git push\` — its upstream is intentionally unset, and never push to ${base}); then run \`gh pr create --base ${base} --title <English> --body <English>\` and report the resulting PR URL.
${opts.historyAccess ? `\n${opts.historyAccess}` : ''}
${opts.ultracode ? `\n${codexUltracodePrompt('feature')}` : ''}

User's message:
${opts.message}

Reply briefly: answer their question, or describe what you changed / propose next steps. ${outputLangClause(opts.lang)}

${askUserClause(opts.lang)}`
}

// 全局「啥都能干」助手（codex）：自由聊 + 直接动手。git 写/push 类会被「执行后」守卫拦（codex 的固有限制）。
export function buildCodexGlobalPrompt(opts: FixChatOptions): string {
  const opening = opts.sessionId
    ? 'You are continuing the same Codex thread as a general-purpose coding assistant.'
    : 'You are a general-purpose coding assistant in a Codex thread.'
  return `${opening}

The current directory is the user's chosen working directory. Investigate and do whatever the user asks by editing files / running commands directly. Keep answers focused.
${opts.historyAccess ? `\n${opts.historyAccess}` : ''}
${opts.ultracode ? `\n${codexUltracodePrompt('global')}` : ''}

User's message:
${opts.message}

Reply briefly. ${outputLangClause(opts.lang)}

${askUserClause(opts.lang)}`
}

function emitCodexChatEvent(
  event: ThreadEvent,
  seenTextByItem: Map<string, number>,
  commandGuard: { scope: CodexCommandGuardScope; allowDanger?: boolean; networkAccess?: boolean } | null,
  onTool?: (name: string, info: string) => void,
  onText?: (text: string) => void,
): string | null {
  if (event.type === 'turn.failed') throw new CodexChatError(`Codex chat turn failed: ${extractCodexErrorMessage(event.error.message)}`)
  if (event.type === 'error') throw new CodexChatError(`Codex chat stream failed: ${extractCodexErrorMessage(event.message)}`)
  if (event.type === 'thread.started' || event.type === 'turn.started' || event.type === 'turn.completed') return null

  const { item } = event
  if (item.type === 'agent_message') {
    const previous = seenTextByItem.get(item.id) ?? 0
    const next = item.text.slice(previous)
    seenTextByItem.set(item.id, item.text.length)
    if (next) onText?.(next)
    return event.type === 'item.completed' ? item.text : null
  }

  if (event.type !== 'item.completed') return null

  if (item.type === 'command_execution') {
    onTool?.('CodexCommand', item.command.slice(0, 100))
    if (commandGuard && shouldBlockCodexCommand(item.command, commandGuard)) {
      throw new CodexChatError(`Codex chat attempted a forbidden git/GitHub mutation: ${item.command}`)
    }
  } else if (item.type === 'file_change') {
    onTool?.('CodexFileChange', item.changes.map((change) => `${change.kind}:${change.path}`).join(', ').slice(0, 100))
  } else if (item.type === 'mcp_tool_call') {
    onTool?.('CodexMcp', `${item.server}.${item.tool}`.slice(0, 100))
  } else if (item.type === 'web_search') {
    onTool?.('CodexWebSearch', item.query.slice(0, 100))
  } else if (item.type === 'error') {
    // ErrorItem 在 SDK 里是「非致命」错误（如 codex 插件 hooks 解析告警）。出日志、不中断本轮。
    // 真正致命的是 turn.failed / 顶层 error 事件（上面已抛）/ 本轮无最终输出（调用方兜底）。
    onTool?.('CodexWarning', item.message.slice(0, 140))
  }
  return null
}

export async function runCodexChat(opts: FixChatOptions): Promise<FixChatResult> {
  const runTurn = async (sessionId: string | null): Promise<FixChatResult> => {
    const runOpts = { ...opts, sessionId }
    // 用共享的 newCodex()：它带 codexPathOverride，绕开 nitro 打包后找不到二进制的问题。
    // 5.6 Sol/Terra 支持 CLI 原生 ultra；其他模型继续使用 xhigh + 项目提示词工作流。
    const requestedEffort = runOpts.ultracode
      ? codexUltracodeEffort(await getCodexModels(), runOpts.model)
      : runOpts.effort
    const effort = toCodexEffort(requestedEffort)
    const codex = newCodex({
      ...('codexServiceTier' in runOpts ? { serviceTier: runOpts.codexServiceTier } : {}),
      ...(effort ? { reasoningEffort: effort } : {}),
    })
    // 网络只跟随「feature 开 PR」这类显式意图（feature 会同时传 fullAccess+networkAccess）。
    // fix 的 allowDanger 只放开本地沙箱（rm 等危险本地操作），**不开网络**——fix 从不需要 agent 自己 push
    // （上传走独立 Node 路径），且 codex 的 git-mutation 守卫是「执行后」才拦，开了网络会让 push 先落地再报错。
    const network = !!runOpts.networkAccess
    const fullSandbox = !!(runOpts.fullAccess || runOpts.allowDanger)
    const threadOptions: ThreadOptions = {
      ...(runOpts.model ? { model: runOpts.model } : {}),
      ...codexWorkingDirectoryOptions(runOpts.cwd),
      sandboxMode: fullSandbox ? 'danger-full-access' : 'workspace-write',
      approvalPolicy: 'never',
      networkAccessEnabled: network,
      webSearchMode: network ? 'live' : 'disabled',
      webSearchEnabled: network,
    }
    const thread = sessionId
      ? codex.resumeThread(sessionId, threadOptions)
      : codex.startThread(threadOptions)
    if (thread.id) runOpts.onSessionId?.(thread.id)

    const controller = new AbortController()
    runOpts.onStop?.(() => controller.abort())

    const { events } = await thread.runStreamed(buildCodexChatPrompt(runOpts), { signal: controller.signal })
    const seenTextByItem = new Map<string, number>()
    let text = ''
    const commandGuard = runOpts.promptKind === 'global'
      ? null
      : {
          scope: runOpts.promptKind === 'feature' ? 'feature' : 'fix',
          allowDanger: !!runOpts.allowDanger,
          networkAccess: !!runOpts.networkAccess,
        } as const
    for await (const event of events) {
      if (event.type === 'thread.started') runOpts.onSessionId?.(event.thread_id)
      const finalText = emitCodexChatEvent(event, seenTextByItem, commandGuard, runOpts.onTool, runOpts.onText)
      if (finalText != null) text = finalText
    }

    return { costUsd: 0, sessionId: thread.id, text: text.trim() }
  }

  try {
    return await runTurn(opts.sessionId)
  } catch (error) {
    if (shouldRetryCodexChatWithoutThread(error, !!opts.sessionId)) {
      opts.onTool?.('CodexResume', 'saved thread id was invalid; started a fresh thread')
      return runTurn(null)
    }
    throw normalizeCodexChatError(error)
  }
}

export const codexChatRunner: ChatRunner = {
  runChat: runCodexChat,
}

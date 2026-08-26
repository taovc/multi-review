<script setup lang="ts">
// The ONE chat surface for session runs (PR worktree / feature branch worktree / working directory). Replaces
// FixPanel, FeatureDrawer and the body of GlobalChat: turns + host cards (permission / question / plan) + the legacy
// ```ask-user decision card, the composer with slash palette, the danger/mode/ultracode switches, and per-workspace
// actions — commit & upload preview (PR), open/update PR (feature), worktree tools, open in IDE/terminal.
// The run is created lazily on the first message (POST /api/runs); the parent learns the id through `created`.
import { stripRecommendedMarker } from '~core/agent/decisionCard'
import { useRunHost, PERMISSION_MODES, type Pending, type HostInfo, type PermissionMode, type RunSummary } from '../../composables/useRunHost'

type WorkspaceType = 'pr_worktree' | 'branch_worktree' | 'cwd'
const props = withDefaults(defineProps<{
  runId: string | null
  workspaceType: WorkspaceType
  projectId?: string | null
  prNumber?: number | null
  active?: boolean
}>(), { projectId: null, prNumber: null, active: true })
const emit = defineEmits<{ changed: []; created: [id: string]; deleted: [id: string]; clear: []; history: [] }>()
const { t, te, locale } = useI18n()
const toast = useToast()

type Turn = { id: string; seq: number; role: 'user' | 'assistant'; content: string; status: string }
type Detail = {
  run: any
  project: { id: string; name: string; repo: string; defaultBranch: string } | null
  turns: Turn[]
  events: { ts: string; kind: string; message: string | null }[]
  busy: boolean
  host?: HostInfo
  pending?: Pending[]
  summary?: RunSummary
  workspace: { path: string | null; exists: boolean; hasUnpushed: boolean; filesChanged: number; additions: number; deletions: number; prUrl: string | null; commitUrl: string | null }
}

const currentRunId = ref<string | null>(props.runId)
watch(() => props.runId, (v) => { currentRunId.value = v })
const data = ref<Detail | null>(null)
const view = ref<'chat' | 'preview'>('chat')
const input = ref('')
const liveAssistant = ref('')
const logLines = ref<string[]>([])
const busy = ref('') // '' | 'delete' | 'rmwt' | 'upload' | 'send'
const pendingCwd = ref<string | null>(null)
const { confirming } = useInlineConfirm() // '' | 'delete' | 'rmwt'
let es: EventSource | null = null
let loadToken = 0

function pushLog(line: string) {
  logLines.value.push(`${hhmmss()}  ${line}`)
  if (logLines.value.length > 300) logLines.value.shift()
}
function notify(msg: string, ok = false) { toast.add({ title: msg, color: ok ? 'success' : 'error', icon: ok ? 'i-lucide-check' : 'i-lucide-triangle-alert' }) }
function hhmmss(iso?: string) { return new Date(iso ?? new Date().toISOString()).toLocaleTimeString(locale.value, { hour12: false }) }

const host = useRunHost(currentRunId, { pushLog, notify })
const { mode, liveStatus, hostCommands, pending } = host

// ── switches remembered per workspace kind (mode / danger / ultracode) ──
const wt = computed(() => props.workspaceType)
const LS = (k: string) => `mr.session.${wt.value}.${k}`
const LEGACY = { pr_worktree: 'fix', branch_worktree: 'feature', cwd: 'global' } as const
const ls = (k: string): string | null => { try { return localStorage.getItem(LS(k)) ?? localStorage.getItem(`mr.${LEGACY[wt.value]}.${k}`) } catch { return null } }
const allowDanger = ref(false)
const ultracodeOn = ref(false)
function loadSwitches() {
  allowDanger.value = ls('allowDanger') === '1'
  ultracodeOn.value = ls('ultracode') === '1'
  const m = ls('mode') as PermissionMode | null
  // Worktree sessions edit code by design: bypassPermissions + the danger guard is the default; the assistant asks by default.
  mode.value = m && PERMISSION_MODES.includes(m) ? m : (wt.value === 'cwd' ? 'default' : 'bypassPermissions')
}
onMounted(loadSwitches)
watch(wt, loadSwitches)
watch(mode, (m) => { if (import.meta.client) try { localStorage.setItem(LS('mode'), m) } catch { /* ignore */ } })
watch(allowDanger, (v) => {
  if (import.meta.client) try { localStorage.setItem(LS('allowDanger'), v ? '1' : '0') } catch { /* ignore */ }
  if (currentRunId.value) void host.setAllowDanger(v)
})
function toggleUltracode() {
  ultracodeOn.value = !ultracodeOn.value
  if (import.meta.client) try { localStorage.setItem(LS('ultracode'), ultracodeOn.value ? '1' : '0') } catch { /* ignore */ }
}

// ── derived state ──
const run = computed(() => data.value?.run)
const chatting = computed(() => {
  const ts = data.value?.turns ?? []
  return !!data.value?.busy || (ts.length > 0 && ts[ts.length - 1]!.role === 'assistant' && ts[ts.length - 1]!.status === 'streaming')
})
const pushing = computed(() => run.value?.busyAction === 'pushing')
const canChat = computed(() => !chatting.value && !pushing.value && !busy.value)
const isPr = computed(() => wt.value === 'pr_worktree')
const isBranch = computed(() => wt.value === 'branch_worktree')
const isCwd = computed(() => wt.value === 'cwd')
function fixStatusLabel(s: string) { const k = `status.fix.${s}`; return te(k) ? t(k) : s }
const FEATURE_STATUS: Record<string, { key: string; cls: string }> = {
  running: { key: 'feature.status.working', cls: 'text-toned border-accented' },
  awaiting_input: { key: 'feature.status.awaiting', cls: 'text-warning border-warning/40' },
  idle: { key: 'feature.status.working', cls: 'text-toned border-accented' },
  stopped: { key: 'feature.status.working', cls: 'text-toned border-accented' },
  error: { key: 'feature.status.error', cls: 'text-error border-error/40' },
}
const featureBadge = computed(() => {
  if (run.value?.prUrl) return { key: 'feature.status.opened', cls: 'text-success border-success/40' }
  return FEATURE_STATUS[run.value?.status] ?? { key: 'feature.status.working', cls: 'text-dimmed border-default' }
})

// ── decision card (legacy ```ask-user block; Codex and older transcripts) ──
const otherAnswer = ref('')
const ASK_RE = /```ask-user\s*\n([\s\S]*?)```/i
const IS_OPT = /^(?:[-*]|\d+[.)])\s+/
const askCard = computed(() => {
  const ts = data.value?.turns ?? []
  const last = ts[ts.length - 1]
  if (!last || last.role !== 'assistant' || last.status === 'streaming') return null
  const m = last.content.match(ASK_RE)
  if (!m) return null
  const lines = m[1]!.split('\n').map((l) => l.trim()).filter(Boolean)
  const options = lines.filter((l) => IS_OPT.test(l)).map((l) => l.replace(IS_OPT, '').trim()).filter(Boolean)
  const question = lines.filter((l) => !IS_OPT.test(l)).join('\n').trim()
  return { question, options }
})
function askQuestionText(inner: string): string { return inner.split('\n').map((l) => l.trim()).filter((l) => l && !IS_OPT.test(l)).join('\n') }
function displayText(content: string, stripAsk: boolean): string {
  return content.replace(/```ask-user\s*\n([\s\S]*?)```/gi, (_m, inner) => (stripAsk ? '' : askQuestionText(inner))).trim()
}
function answer(opt: string) { void send(stripRecommendedMarker(opt)) }
function answerOther() { const v = otherAnswer.value.trim(); if (!v) return; send(v).then((ok) => { if (ok) otherAnswer.value = '' }) }

// ── load / SSE ──
async function load() {
  const id = currentRunId.value
  if (!id) return
  const my = ++loadToken
  const detail = await $fetch<Detail>(`/api/runs/${id}`)
  if (my !== loadToken || id !== currentRunId.value) return // stale
  data.value = detail
  host.applyDetail({ host: detail.host, pending: detail.pending, run: detail.summary ?? null })
  if (!logLines.value.length && detail.events?.length) logLines.value = detail.events.filter((e) => e.message).map((e) => `${hhmmss(e.ts)}  ${e.message}`)
  emit('changed')
}
function openSSE() {
  if (!currentRunId.value || !import.meta.client) return
  es?.close()
  const id = currentRunId.value
  es = new EventSource(`/api/runs/${id}/stream`)
  es.onmessage = (ev) => {
    if (id !== currentRunId.value) return
    try {
      const e = JSON.parse(ev.data)
      if (e.kind === 'run') { host.onRunEvent(e.data); return }
      if (e.kind === 'text') { liveAssistant.value += e.message || ''; return }
      if (e.message && e.kind !== 'chat' && e.kind !== 'status') pushLog(e.message)
      if (['done', 'status', 'error', 'chat'].includes(e.kind)) { liveAssistant.value = ''; load() }
    } catch { /* ignore */ }
  }
  es.onopen = () => { if (data.value) load() }
}
function closeSSE() { es?.close(); es = null }
function resetLocal() { data.value = null; liveAssistant.value = ''; logLines.value = []; otherAnswer.value = ''; confirming.value = ''; view.value = 'chat'; host.reset() }

watch(() => [props.active, currentRunId.value] as const, async ([on, id]) => {
  if (!on) { closeSSE(); return }
  resetLocal()
  if (id) { await load(); openSSE(); scrollToBottom() } else closeSSE()
}, { immediate: true })
onBeforeUnmount(() => { closeSSE(); if (timer) clearInterval(timer); if (pollTimer) clearInterval(pollTimer) })

const { scrollEl, scrollToBottom } = useScrollToBottom()
watch([view, () => data.value?.turns.length, liveAssistant, () => pending.value.length], ([v]) => { if (v === 'chat') scrollToBottom() })
const elapsed = ref(0)
let timer: ReturnType<typeof setInterval> | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
watch(chatting, (on) => {
  if (timer) { clearInterval(timer); timer = null }
  if (on) { elapsed.value = 0; timer = setInterval(() => { elapsed.value++ }, 1000) }
})
watch([chatting, pushing, () => props.active], ([c, p, on]) => {
  const active = (c || p) && on
  if (active && !pollTimer) pollTimer = setInterval(() => load(), 2500)
  else if (!active && pollTimer) { clearInterval(pollTimer); pollTimer = null }
})

// ── send ──
const LOCAL_COMMANDS = [
  { cmd: '/clear', desc: () => t('global.cmd.clear'), only: 'cwd' },
  { cmd: '/resume', desc: () => t('global.cmd.resume'), only: 'cwd' },
  { cmd: '/copy', desc: () => t('global.cmd.copy'), only: null },
  { cmd: '/cd', desc: () => t('global.cmd.cd'), only: 'cwd' },
] as const
const slashOpen = computed(() => input.value.startsWith('/') && !input.value.includes('\n'))
const slashMatches = computed(() => {
  if (!slashOpen.value) return []
  const head = input.value.split(/\s/)[0]!.toLowerCase()
  const local = LOCAL_COMMANDS.filter((c) => (!c.only || c.only === wt.value) && c.cmd.startsWith(head)).map((c) => ({ cmd: c.cmd, desc: c.desc(), local: true }))
  const remote = hostCommands.value.filter((c) => `/${c}`.toLowerCase().startsWith(head)).slice(0, 12).map((c) => ({ cmd: `/${c}`, desc: '', local: false }))
  return [...local, ...remote]
})
function lastAssistantText(): string {
  const ts = data.value?.turns ?? []
  for (let i = ts.length - 1; i >= 0; i--) if (ts[i]!.role === 'assistant') return ts[i]!.content
  return ''
}
// true = handled locally. Everything else (/compact, /context, skills, custom commands) goes to the agent verbatim.
async function handleSlash(raw: string): Promise<boolean> {
  const [cmd, ...rest] = raw.trim().split(/\s+/)
  const arg = rest.join(' ')
  switch (cmd) {
    case '/clear': if (!isCwd.value) return false; input.value = ''; emit('clear'); return true
    case '/resume': if (!isCwd.value) return false; input.value = ''; emit('history'); return true
    case '/copy': {
      input.value = ''
      const txt = lastAssistantText()
      if (txt && import.meta.client) { await navigator.clipboard.writeText(txt).catch(() => {}); notify(t('global.copied'), true) }
      return true
    }
    case '/cd': {
      if (!isCwd.value || !arg) return false
      input.value = ''
      pendingCwd.value = arg
      notify(t('global.cdSet', { path: arg }), true)
      return true
    }
    default: return false
  }
}
async function ensureRun(firstMessage: string): Promise<string> {
  if (currentRunId.value) return currentRunId.value
  const body: Record<string, unknown> = { workspaceType: wt.value, projectId: props.projectId ?? undefined }
  if (isPr.value) body.prNumber = props.prNumber
  if (isBranch.value) body.description = firstMessage
  if (isCwd.value && pendingCwd.value) body.cwd = pendingCwd.value
  const res = await $fetch<{ id: string }>('/api/runs', { method: 'POST', body })
  currentRunId.value = res.id
  emit('created', res.id)
  emit('changed')
  openSSE()
  return res.id
}
async function send(overrideMsg?: string, opts: { allowDanger?: boolean } = {}): Promise<boolean> {
  const msg = (overrideMsg ?? input.value).trim()
  if (!msg || !canChat.value) return false
  if (overrideMsg == null && msg.startsWith('/') && await handleSlash(msg)) return true
  if (overrideMsg == null) input.value = ''
  liveAssistant.value = ''
  busy.value = 'send'
  try {
    const id = await ensureRun(msg)
    await $fetch(`/api/runs/${id}/messages`, { method: 'POST', body: { message: msg, cwd: pendingCwd.value || undefined, allowDanger: opts.allowDanger ?? allowDanger.value, ultracode: ultracodeOn.value, permissionMode: mode.value, projectId: props.projectId ?? undefined } })
    pendingCwd.value = null
    await load()
    return true
  } catch (e: any) {
    if (overrideMsg == null) input.value = msg
    notify(e?.data?.statusMessage || t('common.failed'))
    return false
  } finally { busy.value = '' }
}
function onComposerKey(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); void send() }
}
async function stop() {
  if (!currentRunId.value) return
  try { await $fetch(`/api/runs/${currentRunId.value}/stop`, { method: 'POST' }); await load() }
  catch (e: any) { notify(e?.data?.statusMessage || t('common.failed')) }
}
// Feature: ask the agent to open / update the PR itself (commit, push -u, gh pr create); the danger switch is forced on for that turn.
function openPr() { void send(t('feature.openPrMsg'), { allowDanger: true }) }

// ── commit & upload (PR sessions) ──
type Preview = { diff: string; truncated: boolean; message: string; needsCommit: boolean; filesChanged: number; additions: number; deletions: number }
const preview = ref<Preview | null>(null)
const commitMsg = ref('')
async function openPreview() {
  busy.value = 'upload'
  try {
    const res = await $fetch<Preview>(`/api/runs/${currentRunId.value}/push`, { method: 'POST', body: { dryRun: true } })
    preview.value = res
    commitMsg.value = res.message || ''
    view.value = 'preview'
  } catch (e: any) { notify(e?.data?.statusMessage || t('common.failed')) }
  finally { busy.value = '' }
}
async function confirmUpload() {
  busy.value = 'upload'
  try {
    const res = await $fetch<{ sha: string }>(`/api/runs/${currentRunId.value}/push`, { method: 'POST', body: { dryRun: false, message: commitMsg.value.trim() || undefined } })
    notify(t('fix.pushedOnly', { sha: res.sha }), true)
    view.value = 'chat'
    preview.value = null
    await load()
    emit('changed')
  } catch (e: any) { notify(e?.data?.statusMessage || t('fix.pushFailed')) }
  finally { busy.value = '' }
}

// ── delete / worktree / open in ──
async function doDelete() {
  confirming.value = ''
  if (!currentRunId.value) { emit('deleted', ''); return }
  const id = currentRunId.value
  busy.value = 'delete'
  try {
    await $fetch(`/api/runs/${id}`, { method: 'DELETE' })
    closeSSE()
    loadToken++
    resetLocal()
    currentRunId.value = null
    emit('deleted', id)
    emit('changed')
  } catch (e: any) { notify(e?.data?.statusMessage || t('common.failed')) }
  finally { busy.value = '' }
}
async function doDeleteWorktree() {
  confirming.value = ''
  busy.value = 'rmwt'
  try {
    await $fetch(`/api/runs/${currentRunId.value}/workspace`, { method: 'DELETE' })
    notify(t('fix.worktreeDeleted'), true)
    await load()
    emit('changed')
  } catch (e: any) { notify(e?.data?.statusMessage || t('common.failed')) }
  finally { busy.value = '' }
}
async function copyPath() {
  const p = data.value?.workspace.path
  if (!p) return
  try { await navigator.clipboard.writeText(p); notify(t('fix.pathCopied'), true) } catch { /* ignore */ }
}
async function openIn(app: 'vscode' | 'cursor' | 'terminal' | 'finder') {
  if (!currentRunId.value) return
  try { await $fetch(`/api/runs/${currentRunId.value}/open`, { method: 'POST', body: { app } }) }
  catch (e: any) { notify(e?.data?.statusMessage || t('common.failed')) }
}
const canOpenIde = computed(() => !!data.value?.workspace.exists)
</script>

<template>
  <div class="flex flex-col min-h-0 flex-1">
    <!-- ── Upload preview (PR sessions): diff + editable commit message ── -->
    <template v-if="view === 'preview' && preview">
      <div class="shrink-0">
        <div class="flex items-center gap-3 mb-3">
          <button class="text-sm text-dimmed hover:text-highlighted" @click="view = 'chat'">← {{ $t('fix.backToChat') }}</button>
          <span class="text-xs text-dimmed tabular-nums ml-auto">
            {{ $t('prDrawer.filesCount', { count: preview.filesChanged }) }} ·
            <span class="text-success">+{{ preview.additions }}</span><span class="text-error"> −{{ preview.deletions }}</span>
          </span>
        </div>
        <template v-if="preview.needsCommit">
          <label class="text-[10px] uppercase tracking-[0.15em] text-dimmed">{{ $t('fix.commitMsgLabel') }}</label>
          <input v-model="commitMsg" type="text" :placeholder="$t('fix.commitMsgPlaceholder')" class="w-full text-sm bg-muted border border-default rounded px-3 py-2 mt-1 mb-3 outline-none focus:border-accented font-mono" />
        </template>
        <p v-else class="text-xs text-dimmed mb-3">{{ $t('fix.rePushHint') }}</p>
        <div class="flex items-center gap-3 mb-3">
          <button class="text-sm bg-inverted text-inverted px-4 py-1.5 hover:bg-inverted/90 disabled:opacity-40" :disabled="(preview.needsCommit && !commitMsg.trim()) || !!busy" @click="confirmUpload">
            {{ busy === 'upload' ? $t('fix.pushing') : $t('fix.commitAndUpload') }}
          </button>
          <button class="text-sm text-dimmed hover:text-highlighted" @click="view = 'chat'">{{ $t('common.cancel') }}</button>
        </div>
      </div>
      <div class="flex-1 min-h-0 overflow-y-auto"><DiffView :diff="preview.diff || ''" :truncated="preview.truncated" /></div>
    </template>

    <template v-else>
      <!-- Header: workspace status / links / delete -->
      <div v-if="currentRunId && data" class="shrink-0">
        <div class="flex items-center gap-3 text-xs mb-2 flex-wrap">
          <template v-if="isPr">
            <span :class="run.status === 'error' ? 'text-error font-medium' : 'text-toned'">{{ fixStatusLabel(run.fixStatus || 'open') }}</span>
            <span v-if="data.workspace.filesChanged > 0" class="text-dimmed tabular-nums">
              {{ $t('prDrawer.filesCount', { count: data.workspace.filesChanged }) }} ·
              <span class="text-success">+{{ data.workspace.additions }}</span><span class="text-error"> −{{ data.workspace.deletions }}</span>
            </span>
            <a v-if="data.workspace.commitUrl" :href="data.workspace.commitUrl" target="_blank" class="text-highlighted hover:underline">{{ $t('fix.viewChanges') }} ↗</a>
          </template>
          <template v-else-if="isBranch">
            <span class="shrink-0 text-[10px] uppercase tracking-wider px-2 py-0.5 border rounded-full" :class="featureBadge.cls">{{ $t(featureBadge.key) }}</span>
            <span v-if="run.branch" class="font-mono text-dimmed truncate">{{ run.branch }}</span>
            <a v-if="run.prUrl" :href="run.prUrl" target="_blank" class="text-highlighted hover:underline whitespace-nowrap">{{ $t('prDrawer.openInGithub') }} ↗</a>
          </template>
          <template v-else>
            <span class="font-mono text-dimmed truncate" :title="data.workspace.path || ''">{{ data.workspace.path || '—' }}</span>
            <span class="text-dimmed">{{ run.provider }}<template v-if="run.model"> · {{ run.model }}</template></span>
          </template>
          <template v-if="confirming === 'delete'">
            <span class="ml-auto text-dimmed">{{ isPr ? $t('fix.discardConfirm') : isBranch ? $t('feature.discardConfirm') : $t('global.confirmDelete') }}</span>
            <button class="text-error font-medium hover:underline disabled:opacity-40" :disabled="!!busy" @click="doDelete">{{ $t('common.delete') }}</button>
            <button class="text-dimmed hover:text-highlighted" @click="confirming = ''">{{ $t('common.cancel') }}</button>
          </template>
          <button v-else class="ml-auto text-dimmed hover:text-highlighted disabled:opacity-40 whitespace-nowrap" :disabled="chatting || pushing || !!busy" @click="confirming = 'delete'">{{ isPr ? $t('fix.discard') : isBranch ? $t('feature.discard') : $t('common.delete') }}</button>
        </div>
        <p v-if="run.error" class="text-xs text-error border border-default rounded p-2 mb-2 whitespace-pre-wrap">{{ run.error }}</p>
      </div>

      <ChatLogPanel :lines="logLines" />

      <!-- Chat stream -->
      <div ref="scrollEl" class="flex-1 min-h-0 overflow-y-auto space-y-3 pr-1">
        <p v-if="!data || !data.turns.length" class="text-sm text-dimmed py-8 text-center whitespace-pre-line">{{ isPr ? $t('fix.chatHint') : isBranch ? $t('feature.newHint') : $t('global.empty') }}</p>
        <div v-for="(turn, ti) in data?.turns ?? []" :key="turn.id" :class="turn.role === 'user' ? 'text-right' : ''">
          <div v-if="turn.role === 'user'" class="inline-block max-w-[92%] text-left text-sm rounded-lg px-3 py-2 whitespace-pre-wrap break-words bg-inverted text-inverted">{{ turn.content }}</div>
          <div v-else class="inline-block max-w-[92%] text-left text-sm rounded-lg px-3 py-2 break-words bg-muted">
            <MarkdownBody :text="turn.status === 'streaming' && ti === (data?.turns.length ?? 0) - 1 && liveAssistant.length >= turn.content.length ? liveAssistant : displayText(turn.content, !!askCard && ti === (data?.turns.length ?? 0) - 1)" />
            <span v-if="turn.status === 'streaming'" class="animate-pulse">▍</span>
            <span v-if="turn.status === 'stopped'" class="text-[10px] text-dimmed ml-1">· {{ $t('fix.stoppedTag') }}</span>
            <span v-else-if="turn.status === 'error'" class="text-[10px] text-dimmed ml-1">· {{ $t('common.failed') }}</span>
          </div>
        </div>

        <RunPromptCards :host="host" />

        <div v-if="askCard" class="rounded border border-inverted p-3 space-y-2 text-left">
          <div class="text-[10px] uppercase tracking-[0.15em] text-dimmed">{{ $t('feature.decisionTitle') }}</div>
          <p v-if="askCard.question" class="text-sm font-medium whitespace-pre-wrap text-highlighted">{{ askCard.question }}</p>
          <div v-if="askCard.options.length" class="flex flex-col gap-1.5">
            <button v-for="(o, i) in askCard.options" :key="i" class="text-left text-sm border border-default rounded px-3 py-1.5 hover:border-inverted hover:bg-elevated/40 disabled:opacity-40" :disabled="!canChat" @click="answer(o)">{{ o }}</button>
          </div>
          <div class="flex items-center gap-2 pt-1">
            <input v-model="otherAnswer" :placeholder="$t('feature.decisionOther')" class="flex-1 text-sm border-b border-default focus:border-inverted outline-none py-1 bg-transparent" :disabled="!canChat" @keydown.enter="answerOther" />
            <button class="text-xs text-dimmed hover:text-highlighted disabled:opacity-40" :disabled="!canChat || !otherAnswer.trim()" @click="answerOther">{{ $t('global.send') }}</button>
          </div>
        </div>

        <div v-if="chatting" class="text-xs text-toned flex items-center gap-2">
          <span class="inline-block w-1.5 h-1.5 rounded-full bg-inverted animate-pulse" />{{ liveStatus === 'waiting_prompt' ? $t('global.live.waiting_prompt') : $t('global.thinking') }}… {{ elapsed }}s
        </div>
      </div>

      <!-- Composer -->
      <div class="shrink-0 relative border-t border-default pt-3 mt-2 space-y-2">
        <div v-if="slashMatches.length" class="absolute bottom-full left-0 mb-1 w-full max-h-64 overflow-y-auto bg-default border border-default rounded shadow-lg z-10">
          <div v-for="c in slashMatches" :key="c.cmd" class="flex items-center justify-between gap-3 px-3 py-1.5 text-xs hover:bg-muted cursor-pointer" @click="input = c.cmd + ' '">
            <span class="font-mono text-highlighted">{{ c.cmd }}</span>
            <span class="text-dimmed truncate">{{ c.desc || (c.local ? '' : $t('global.commandsHint')) }}</span>
          </div>
        </div>
        <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
          <label class="flex items-center gap-2 cursor-pointer">
            <input v-model="allowDanger" type="checkbox" class="accent-error" />
            <span :class="allowDanger ? 'text-error' : 'text-dimmed'">{{ allowDanger ? $t('global.dangerOn') : $t('global.dangerOff') }}</span>
          </label>
          <RunHostStrip :host="host" :live="!!currentRunId" :tokens="data?.summary" />
        </div>
        <span v-if="pendingCwd" class="block text-[11px] text-dimmed">{{ $t('global.cdPending', { path: pendingCwd }) }}</span>
        <textarea
          v-model="input" rows="2"
          :placeholder="isPr ? $t('fix.chatPlaceholder') : isBranch ? (currentRunId ? $t('feature.chatPlaceholder') : $t('feature.composerPlaceholder')) : $t('global.placeholder')"
          class="w-full text-sm bg-muted border border-default rounded px-2 py-1.5 resize-y outline-none focus:border-accented disabled:opacity-50"
          :disabled="chatting" @keydown="onComposerKey"
        />
        <div class="flex items-center gap-3 flex-wrap">
          <button
            type="button"
            class="ultra-btn relative overflow-hidden shrink-0 text-xs rounded px-2.5 py-1.5 font-medium text-white shadow-sm transition"
            :class="ultracodeOn ? 'is-active bg-gradient-to-r from-purple-600 to-fuchsia-600 ring-2 ring-purple-300' : 'bg-gradient-to-r from-neutral-500 to-neutral-600 opacity-80 hover:opacity-100'"
            :title="$t('global.ultracodeHint')" :aria-pressed="ultracodeOn" @click="toggleUltracode"
          >
            <span class="relative z-10 flex items-center gap-1">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M12 3l1.6 3.9L17.5 8.5l-3.9 1.6L12 14l-1.6-3.9L6.5 8.5l3.9-1.6L12 3Z" /></svg>
              {{ $t('global.ultracode') }}
            </span>
          </button>
          <button v-if="isPr && data?.workspace.hasUnpushed" class="text-sm bg-inverted text-inverted px-4 py-1.5 rounded hover:bg-inverted/90 disabled:opacity-40" :disabled="!canChat" @click="openPreview">
            {{ busy === 'upload' ? $t('common.loading') : $t('fix.commitAndUpload') }}
          </button>
          <button v-if="isBranch && currentRunId" class="text-sm bg-inverted text-inverted px-4 py-1.5 rounded hover:bg-inverted/90 disabled:opacity-40" :disabled="!canChat" @click="openPr">{{ run?.prUrl ? $t('feature.updatePr') : $t('feature.openPr') }}</button>
          <div class="ml-auto">
            <button v-if="chatting" class="w-24 text-sm border border-accented rounded py-1.5 hover:bg-muted" @click="stop">{{ $t('fix.stop') }}</button>
            <button v-else class="w-24 text-sm bg-inverted text-inverted rounded py-1.5 hover:bg-inverted/90 disabled:opacity-40" :disabled="!input.trim() || !canChat" @click="send()">{{ busy === 'send' && !currentRunId ? $t('feature.creating') : $t('global.send') }}</button>
          </div>
        </div>
        <!-- Workspace tools: path, copy, open in, delete worktree -->
        <div v-if="data?.workspace.path" class="text-[10px] text-dimmed">
          <div v-if="confirming === 'rmwt'" class="flex items-center gap-2">
            <span class="flex-1">{{ data.workspace.hasUnpushed ? $t('fix.deleteWorktreeConfirmUnpushed') : $t('fix.deleteWorktreeConfirm') }}</span>
            <button class="text-error font-medium hover:underline shrink-0 disabled:opacity-40" :disabled="!!busy || chatting" @click="doDeleteWorktree">{{ busy === 'rmwt' ? $t('fix.deleting') : $t('common.delete') }}</button>
            <button class="hover:text-highlighted shrink-0" @click="confirming = ''">{{ $t('common.cancel') }}</button>
          </div>
          <div v-else class="flex items-center gap-2 flex-wrap">
            <span class="shrink-0">{{ isCwd ? $t('session.cwdHint') : $t('fix.worktreeHint') }}</span>
            <code class="font-mono truncate flex-1 min-w-0">{{ data.workspace.path }}</code>
            <button class="hover:text-highlighted shrink-0 underline" @click="copyPath">{{ $t('fix.copyPath') }}</button>
            <template v-if="canOpenIde">
              <button class="hover:text-highlighted shrink-0 underline" @click="openIn('vscode')">VS Code</button>
              <button class="hover:text-highlighted shrink-0 underline" @click="openIn('cursor')">Cursor</button>
              <button class="hover:text-highlighted shrink-0 underline" @click="openIn('terminal')">{{ $t('session.terminal') }}</button>
            </template>
            <button v-if="!isCwd" class="hover:text-highlighted shrink-0 underline disabled:opacity-40" :disabled="chatting || pushing || !!busy" @click="confirming = 'rmwt'">{{ $t('fix.deleteWorktree') }}</button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.ultra-btn.is-active::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(110deg, transparent 25%, rgba(255, 255, 255, 0.6) 50%, transparent 75%);
  transform: translateX(-100%);
  animation: ultra-shine 2.4s ease-in-out infinite;
  pointer-events: none;
}
@keyframes ultra-shine {
  0% { transform: translateX(-100%); }
  60%, 100% { transform: translateX(100%); }
}
@media (prefers-reduced-motion: reduce) {
  .ultra-btn.is-active::after { animation: none; }
}
</style>

<script setup lang="ts">
// "Fix PR" panel (pure chat): opening it lands you in a persistent chat box where you talk to Claude inside the PR's worktree and
// let it edit the code directly.
// Nothing is committed automatically; "commit and upload" switches to the preview view (the diff to be uploaded + a generated,
// editable commit message) → commit+push happens only after you confirm.
// Layout: flexes to fill the drawer's fix tab height — the chat stream scrolls internally, the input bar stays pinned at the bottom.
import { stripRecommendedMarker } from '~core/agent/decisionCard'
import { useRunHost, type Pending, type HostInfo, type PermissionMode, type RunSummary } from '../composables/useRunHost'

const props = defineProps<{ projectId: string; prNumber: number; fixId: string | null; active: boolean }>()
const emit = defineEmits<{ changed: [] }>()
const { t, te, locale } = useI18n()

type FixTurn = { id: string; seq: number; role: 'user' | 'assistant'; content: string; status: string }
type FixData = {
  fix: any
  turns: FixTurn[]
  events: { ts: string; kind: string; message: string | null }[]
  hasUnpushed: boolean
  prUrl: string | null
  commitUrl: string | null
  host?: HostInfo
  pending?: Pending[]
  run?: RunSummary
}

const currentFixId = ref<string | null>(props.fixId)
watch(() => props.fixId, (v) => { currentFixId.value = v })

const data = ref<FixData | null>(null)
const busy = ref('') // '' | 'discard' | 'rmwt' | 'upload'
const view = ref<'chat' | 'preview'>('chat')
const logLines = ref<string[]>([]) // run log (worktree setup / tool calls / stages, etc.), expandable
const showLog = ref(false)
let es: EventSource | null = null
// load race guard (same as FeatureDrawer): when switching fixes / discarding, an in-flight load for the old fix must not land back into data.
let loadToken = 0
// Session host (shared with the global drawer): native permission / question / plan cards, mode, context meter, cost.
function pushLog(line: string) {
  logLines.value.push(`${hhmmss()}  ${line}`)
  if (logLines.value.length > 300) logLines.value.shift()
}
const host = useRunHost(currentFixId, { pushLog, notify })
const LS_MODE = 'mr.fix.mode'
watch(currentFixId, () => host.reset())
watch(host.mode, (m) => { if (import.meta.client) localStorage.setItem(LS_MODE, m) })

// Allow dangerous commands + ultracode background activation: persisted in localStorage (across PRs/reloads, same as feature/global); the prefix is injected by the backend.
const allowDanger = ref(false)
const ultracodeOn = ref(false)
const LS_DANGER = 'mr.fix.allowDanger'
const LS_ULTRA = 'mr.fix.ultracode'
onMounted(() => {
  allowDanger.value = localStorage.getItem(LS_DANGER) === '1'
  ultracodeOn.value = localStorage.getItem(LS_ULTRA) === '1'
  // A fix session edits code by design: bypassPermissions + the danger guard is the default, the user can tighten it per session.
  const m = localStorage.getItem(LS_MODE) as PermissionMode | null
  host.mode.value = m && ['default', 'acceptEdits', 'plan', 'bypassPermissions'].includes(m) ? m : 'bypassPermissions'
})
watch(allowDanger, (v) => {
  if (import.meta.client) localStorage.setItem(LS_DANGER, v ? '1' : '0')
  if (currentFixId.value) void host.setAllowDanger(v) // a live host session picks it up immediately
})
function toggleUltracode() {
  ultracodeOn.value = !ultracodeOn.value
  if (import.meta.client) localStorage.setItem(LS_ULTRA, ultracodeOn.value ? '1' : '0')
}

// Decision card (same as FeatureDrawer): the last assistant turn contains an ```ask-user block → question + options; clicking an option sends it as the next message.
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
function askQuestionText(inner: string): string {
  return inner.split('\n').map((l) => l.trim()).filter((l) => l && !IS_OPT.test(l)).join('\n')
}
function displayText(content: string, stripAsk: boolean): string {
  return content.replace(/```ask-user\s*\n([\s\S]*?)```/gi, (_m, inner) => (stripAsk ? '' : askQuestionText(inner))).trim()
}
// The recommended marker on an option button is display-only; strip it before sending (the marker itself is defined in ~core/agent/decisionCard)
function optionLabel(o: string): string { return stripRecommendedMarker(o) }

function hhmmss(iso?: string) {
  return new Date(iso ?? new Date().toISOString()).toLocaleTimeString(locale.value, { hour12: false })
}

const toast = useToast()
function notify(msg: string, ok = false) {
  toast.add({ title: msg, color: ok ? 'success' : 'error', icon: ok ? 'i-lucide-check' : 'i-lucide-triangle-alert' })
}

// Chat in progress = the last assistant turn is still streaming
const chatting = computed(() => {
  const ts = data.value?.turns ?? []
  return ts.length > 0 && ts[ts.length - 1]!.role === 'assistant' && ts[ts.length - 1]!.status === 'streaming'
})
const pushing = computed(() => data.value?.fix?.status === 'pushing')

function fixStatusLabel(s: string) { const k = `status.fix.${s}`; return te(k) ? t(k) : s }

async function load() {
  const fid = currentFixId.value
  if (!fid) return
  const my = ++loadToken
  const detail = await $fetch<FixData>(`/api/fixes/${fid}`)
  if (my !== loadToken || fid !== currentFixId.value) return // stale result (fix switched / a newer load started) → drop it
  data.value = detail
  host.applyDetail(detail)
  // First time: backfill the run log from the persisted historical events
  if (!logLines.value.length && detail.events?.length) {
    logLines.value = detail.events.filter((e) => e.message).map((e) => `${hhmmss(e.ts)}  ${e.message}`)
  }
  emit('changed')
}
function openSSE() {
  if (!currentFixId.value || !import.meta.client) return
  es?.close()
  const fid = currentFixId.value // bind the stream to its fix: leftover messages are no longer written after switching away
  es = new EventSource(`/api/fixes/${fid}/stream`)
  es.onmessage = (ev) => {
    if (fid !== currentFixId.value) return // stale stream → ignore
    try {
      const e = JSON.parse(ev.data)
      if (e.kind === 'run') { host.onRunEvent(e.data); return }
      if (e.kind === 'text') { liveAssistant.value += e.message || ''; return }
      if (e.message) pushLog(e.message)
      if (['done', 'status', 'error', 'chat'].includes(e.kind)) { liveAssistant.value = ''; load() }
    } catch {}
  }
  es.onopen = () => { if (data.value) load() }
}
function closeSSE() { es?.close(); es = null }

// Connect SSE / load when the tab activates; disconnect when leaving. Coming back to the tab always returns to the chat view. Scroll to the bottom after load (to see the latest message).
watch(() => [props.active, currentFixId.value] as const, async ([on, id]) => {
  if (on) {
    view.value = 'chat'
    if (id) { await load(); openSSE(); scrollChatToBottom() } else { data.value = null; closeSSE() }
  } else { closeSSE() }
}, { immediate: true })
onBeforeUnmount(() => { closeSSE(); if (chatTimer) clearInterval(chatTimer); if (pollTimer) clearInterval(pollTimer) })

// ── Chat ──
const chatInput = ref('')
const liveAssistant = ref('')

// Auto-scroll to the bottom when entering the chat / when a new message arrives
const chatScroll = ref<HTMLElement | null>(null)
function scrollChatToBottom() {
  const go = () => { const el = chatScroll.value; if (el) el.scrollTop = el.scrollHeight }
  // Second scroll pass: the content height can change again after MarkdownBody renders (the first scroll misses the real bottom)
  nextTick(() => { go(); setTimeout(go, 80) })
}
watch([view, () => data.value?.turns.length, liveAssistant], ([v]) => { if (v === 'chat') scrollChatToBottom() })

const chatElapsed = ref(0)
const VERBS = ['Thinking', 'Working', 'Reading', 'Editing', 'Reasoning', 'Crunching', 'Resolving']
const chatVerb = computed(() => VERBS[Math.floor(chatElapsed.value / 3) % VERBS.length])
let chatTimer: ReturnType<typeof setInterval> | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
watch(chatting, (on) => {
  if (chatTimer) { clearInterval(chatTimer); chatTimer = null }
  if (on) { chatElapsed.value = 0; chatTimer = setInterval(() => { chatElapsed.value++ }, 1000) }
})
watch([chatting, pushing, () => props.active], ([c, p, on]) => {
  const active = (c || p) && on
  if (active && !pollTimer) pollTimer = setInterval(() => load(), 2500)
  else if (!active && pollTimer) { clearInterval(pollTimer); pollTimer = null }
})

async function sendChat(overrideMsg?: string): Promise<boolean> {
  const msg = (overrideMsg ?? chatInput.value).trim()
  if (!msg || chatting.value || !!busy.value) return false
  if (overrideMsg == null) chatInput.value = ''
  liveAssistant.value = ''
  try {
    // Lazy creation: if there is no fix row yet, create one first (without running validation), then send the first message
    if (!currentFixId.value) {
      const res = await $fetch<{ id: string }>(`/api/projects/${props.projectId}/pulls/${props.prNumber}/fix`, { method: 'POST' })
      currentFixId.value = res.id
      emit('changed')
      openSSE()
    }
    await $fetch(`/api/fixes/${currentFixId.value}/chat`, { method: 'POST', body: { message: msg, allowDanger: allowDanger.value, ultracode: ultracodeOn.value, permissionMode: host.mode.value } })
    await load()
    return true
  } catch (e: any) {
    if (overrideMsg == null) chatInput.value = msg
    notify(e?.data?.statusMessage || t('common.failed'))
    return false
  }
}
// Decision-card option / free-form "other…" answer (a failed send must not lose the text the user typed)
function answer(opt: string) { void sendChat(optionLabel(opt)) }
function answerOther() { const v = otherAnswer.value.trim(); if (!v) return; sendChat(v).then((ok) => { if (ok) otherAnswer.value = '' }) }
async function stopChat() {
  try { await $fetch(`/api/fixes/${currentFixId.value}/stop`, { method: 'POST' }); await load() }
  catch (e: any) { notify(e?.data?.statusMessage || t('common.failed')) }
}

// ── Commit and upload: preview view ──
const preview = ref<{ diff: string; truncated: boolean; message: string; needsCommit: boolean; filesChanged: number; additions: number; deletions: number } | null>(null)
const commitMsg = ref('')
async function openPreview() {
  busy.value = 'upload'
  try {
    const res = await $fetch<{ diff: string; truncated: boolean; message: string; needsCommit: boolean; filesChanged: number; additions: number; deletions: number }>(
      `/api/fixes/${currentFixId.value}/push`, { method: 'POST', body: { dryRun: true } },
    )
    preview.value = res
    commitMsg.value = res.message || ''
    view.value = 'preview'
  } catch (e: any) { notify(e?.data?.statusMessage || t('common.failed')) }
  finally { busy.value = '' }
}
async function confirmUpload() {
  busy.value = 'upload'
  try {
    const res = await $fetch<{ sha: string }>(`/api/fixes/${currentFixId.value}/push`, { method: 'POST', body: { dryRun: false, message: commitMsg.value.trim() || undefined } })
    notify(t('fix.pushedOnly', { sha: res.sha }), true)
    view.value = 'chat'
    preview.value = null
    await load()
  } catch (e: any) { notify(e?.data?.statusMessage || t('fix.pushFailed')) }
  finally { busy.value = '' }
}

// ── Discard task / delete worktree ──
const confirming = ref<'' | 'discard'>('')
async function doDiscard() {
  confirming.value = ''
  busy.value = 'discard'
  try {
    await $fetch(`/api/fixes/${currentFixId.value}/discard`, { method: 'POST' })
    closeSSE()
    data.value = null
    currentFixId.value = null
    emit('changed')
  } catch (e: any) { notify(e?.data?.statusMessage || t('common.failed')) }
  finally { busy.value = '' }
}
const rmwtConfirm = ref(false)
async function doDeleteWorktree() {
  busy.value = 'rmwt'
  try {
    await $fetch(`/api/fixes/${currentFixId.value}/worktree`, { method: 'DELETE' })
    rmwtConfirm.value = false
    notify(t('fix.worktreeDeleted'), true)
    await load()
    emit('changed')
  } catch (e: any) { notify(e?.data?.statusMessage || t('common.failed')) }
  finally { busy.value = '' }
}
async function copyWorktree() {
  const p = data.value?.fix?.worktreePath
  if (!p) return
  try { await navigator.clipboard.writeText(p); notify(t('fix.pathCopied'), true) } catch { /* ignore */ }
}
</script>

<template>
  <div class="flex flex-col min-h-0 flex-1">
    <!-- ── Preview view: diff to be uploaded + editable commit message ── -->
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
          <input
            v-model="commitMsg" type="text" :placeholder="$t('fix.commitMsgPlaceholder')"
            class="w-full text-sm bg-muted border border-default rounded px-3 py-2 mt-1 mb-3 outline-none focus:border-accented font-mono"
          />
        </template>
        <p v-else class="text-xs text-dimmed mb-3">{{ $t('fix.rePushHint') }}</p>
        <div class="flex items-center gap-3 mb-3">
          <button
            class="text-sm bg-inverted text-inverted px-4 py-1.5 hover:bg-inverted/90 disabled:opacity-40"
            :disabled="(preview.needsCommit && !commitMsg.trim()) || !!busy" @click="confirmUpload"
          >
            {{ busy === 'upload' ? $t('fix.pushing') : $t('fix.commitAndUpload') }}
          </button>
          <button class="text-sm text-dimmed hover:text-highlighted" @click="view = 'chat'">{{ $t('common.cancel') }}</button>
        </div>
      </div>
      <div class="flex-1 min-h-0 overflow-y-auto">
        <DiffView :diff="preview.diff || ''" :truncated="preview.truncated" />
      </div>
    </template>

    <!-- ── Chat view ── -->
    <template v-else>
      <!-- Header (fixed): status + stats + discard + error banner -->
      <div v-if="currentFixId && data" class="shrink-0">
        <div class="flex items-center gap-3 text-xs mb-3">
          <span :class="data.fix.status === 'error' ? 'text-error font-medium' : 'text-toned'">{{ fixStatusLabel(data.fix.status) }}</span>
          <span v-if="(data.fix.filesChanged ?? 0) > 0" class="text-dimmed tabular-nums">
            {{ $t('prDrawer.filesCount', { count: data.fix.filesChanged }) }} ·
            <span class="text-success">+{{ data.fix.additions }}</span><span class="text-error"> −{{ data.fix.deletions }}</span>
          </span>
          <a v-if="data.commitUrl" :href="data.commitUrl" target="_blank" class="text-highlighted hover:underline">{{ $t('fix.viewChanges') }} ↗</a>
          <template v-if="confirming === 'discard'">
            <span class="ml-auto text-dimmed">{{ $t('fix.discardConfirm') }}</span>
            <button class="text-error font-medium hover:underline disabled:opacity-40" :disabled="!!busy" @click="doDiscard">{{ $t('common.delete') }}</button>
            <button class="text-dimmed hover:text-highlighted" @click="confirming = ''">{{ $t('common.cancel') }}</button>
          </template>
          <button v-else class="ml-auto text-dimmed hover:text-highlighted disabled:opacity-40 whitespace-nowrap" :disabled="chatting || pushing || !!busy" @click="confirming = 'discard'">{{ $t('fix.discard') }}</button>
        </div>
        <p v-if="data.fix.error" class="text-xs text-error border border-default rounded p-2 mb-3 whitespace-pre-wrap">{{ data.fix.error }}</p>
        <div v-if="logLines.length" class="text-[11px] text-dimmed mb-3">
          <button class="hover:text-highlighted" @click="showLog = !showLog">{{ showLog ? $t('review.collapseLog') : $t('review.expandLog', { count: logLines.length }) }}</button>
          <pre v-if="showLog" class="mt-1 max-h-48 overflow-auto bg-neutral-900 text-neutral-300 rounded p-2 leading-relaxed font-mono whitespace-pre-wrap">{{ logLines.join('\n') }}</pre>
        </div>
      </div>

      <!-- Chat stream (scrolling area) -->
      <div ref="chatScroll" class="flex-1 min-h-0 overflow-y-auto">
        <p v-if="(!data || !data.turns.length)" class="text-sm text-dimmed py-8">{{ $t('fix.chatHint') }}</p>
        <template v-else>
          <div v-for="(turn, ti) in data.turns" :key="turn.id" class="mb-3 text-sm">
            <div v-if="turn.role === 'user'" class="text-highlighted">
              <span class="text-[10px] uppercase tracking-wider text-dimmed mr-1.5">{{ $t('fix.you') }}</span>{{ turn.content }}
            </div>
            <div v-else class="text-toned leading-relaxed">
              <MarkdownBody :text="turn.status === 'streaming' && ti === data.turns.length - 1 && liveAssistant ? liveAssistant : displayText(turn.content, !!askCard && ti === data.turns.length - 1)" />
              <span v-if="turn.status === 'streaming'" class="animate-pulse">▍</span>
              <span v-if="turn.status === 'stopped'" class="text-[10px] text-dimmed ml-1">· {{ $t('fix.stoppedTag') }}</span>
              <span v-else-if="turn.status === 'error'" class="text-[10px] text-dimmed ml-1">· {{ $t('common.failed') }}</span>
            </div>
          </div>
        </template>

        <!-- Native prompts from the session host: permission / question / plan -->
        <div class="space-y-3 mb-3"><RunPromptCards :host="host" /></div>

        <!-- Decision card (the agent is waiting on your call; same as feature development) -->
        <div v-if="askCard" class="rounded border border-inverted p-3 space-y-2 mb-3">
          <div class="text-[10px] uppercase tracking-[0.15em] text-dimmed">{{ $t('feature.decisionTitle') }}</div>
          <p v-if="askCard.question" class="text-sm font-medium whitespace-pre-wrap text-highlighted">{{ askCard.question }}</p>
          <div v-if="askCard.options.length" class="flex flex-col gap-1.5">
            <button v-for="(o, i) in askCard.options" :key="i" class="text-left text-sm border border-default rounded px-3 py-1.5 hover:border-inverted hover:bg-elevated/40 disabled:opacity-40" :disabled="chatting || !!busy" @click="answer(o)">{{ o }}</button>
          </div>
          <div class="flex items-center gap-2 pt-1">
            <input v-model="otherAnswer" :placeholder="$t('feature.decisionOther')" class="flex-1 text-sm border-b border-default focus:border-inverted outline-none py-1 bg-transparent" :disabled="chatting || !!busy" @keydown.enter="answerOther" />
            <button class="text-xs text-dimmed hover:text-highlighted disabled:opacity-40" :disabled="chatting || !!busy || !otherAnswer.trim()" @click="answerOther">{{ $t('fix.send') }}</button>
          </div>
        </div>

        <!-- Chat in progress: activity indicator (step details are under "expand log" above) -->
        <div v-if="chatting" class="mb-3 flex items-center gap-2 text-xs text-toned">
          <span class="inline-block w-1.5 h-1.5 rounded-full bg-inverted animate-pulse" />
          <span class="font-mono">{{ chatVerb }}… {{ chatElapsed }}s</span>
        </div>
      </div>

      <!-- Input bar (pinned at the bottom) -->
      <div class="shrink-0 border-t border-default pt-3 mt-1">
        <!-- Allow dangerous commands (git push / gh pr create are blocked by default and only let through once enabled, same as feature/global) -->
        <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] mb-2">
          <label class="flex items-center gap-2 cursor-pointer">
            <input v-model="allowDanger" type="checkbox" class="accent-error" />
            <span :class="allowDanger ? 'text-error' : 'text-dimmed'">{{ allowDanger ? $t('global.dangerOn') : $t('global.dangerOff') }}</span>
          </label>
          <RunHostStrip :host="host" :live="!!currentFixId" :tokens="data?.run" />
        </div>
        <textarea
          v-model="chatInput" rows="3" :placeholder="$t('fix.chatPlaceholder')" :disabled="chatting"
          class="w-full text-sm bg-muted border border-default rounded px-2 py-1.5 resize-y outline-none focus:border-accented disabled:opacity-50"
        />
        <div class="mt-2 flex items-center gap-3">
          <!-- ultracode background activation: inactive = grey gradient, active = purple gradient + shine sweep; one click is remembered permanently -->
          <button
            type="button"
            class="ultra-btn relative overflow-hidden shrink-0 text-xs rounded px-2.5 py-1.5 font-medium text-white shadow-sm transition"
            :class="ultracodeOn ? 'is-active bg-gradient-to-r from-purple-600 to-fuchsia-600 ring-2 ring-purple-300' : 'bg-gradient-to-r from-neutral-500 to-neutral-600 opacity-80 hover:opacity-100'"
            :title="$t('global.ultracodeHint')" :aria-pressed="ultracodeOn"
            @click="toggleUltracode"
          >
            <span class="relative z-10 flex items-center gap-1">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true">
                <path d="M12 3l1.6 3.9L17.5 8.5l-3.9 1.6L12 14l-1.6-3.9L6.5 8.5l3.9-1.6L12 3Z" />
              </svg>
              {{ $t('global.ultracode') }}
            </span>
          </button>
          <button
            v-if="data?.hasUnpushed"
            class="text-sm bg-inverted text-inverted px-4 py-1.5 hover:bg-inverted/90 disabled:opacity-40"
            :disabled="chatting || pushing || !!busy" @click="openPreview"
          >
            {{ busy === 'upload' ? $t('common.loading') : $t('fix.commitAndUpload') }}
          </button>
          <div class="ml-auto">
            <button v-if="chatting" class="w-24 text-sm border border-accented py-1.5 hover:bg-muted" @click="stopChat">{{ $t('fix.stop') }}</button>
            <button v-else class="w-24 text-sm bg-inverted text-inverted py-1.5 hover:bg-inverted/90 disabled:opacity-40" :disabled="!chatInput.trim() || !!busy" @click="sendChat()">{{ $t('fix.send') }}</button>
          </div>
        </div>
      </div>

      <!-- worktree tools (pinned at the bottom) -->
      <div v-if="data?.fix?.worktreePath" class="shrink-0 mt-2 text-[10px] text-dimmed">
        <div v-if="rmwtConfirm" class="flex items-center gap-2">
          <span class="flex-1">{{ data.hasUnpushed ? $t('fix.deleteWorktreeConfirmUnpushed') : $t('fix.deleteWorktreeConfirm') }}</span>
          <button class="text-error font-medium hover:underline shrink-0 disabled:opacity-40" :disabled="!!busy || chatting" @click="doDeleteWorktree">{{ busy === 'rmwt' ? $t('fix.deleting') : $t('common.delete') }}</button>
          <button class="hover:text-highlighted shrink-0" @click="rmwtConfirm = false">{{ $t('common.cancel') }}</button>
        </div>
        <div v-else class="flex items-center gap-2">
          <span class="shrink-0">{{ $t('fix.worktreeHint') }}</span>
          <code class="font-mono truncate flex-1">{{ data.fix.worktreePath }}</code>
          <button class="hover:text-highlighted shrink-0 underline" @click="copyWorktree">{{ $t('fix.copyPath') }}</button>
          <button class="hover:text-highlighted shrink-0 underline disabled:opacity-40" :disabled="chatting || pushing || !!busy" @click="rmwtConfirm = true">{{ $t('fix.deleteWorktree') }}</button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* ultracode button: the highlight sweep only runs in the active state; inactive is grey with no sweep. */
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

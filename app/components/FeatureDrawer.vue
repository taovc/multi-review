<script setup lang="ts">
// Feature task drawer (single-phase, native): a free-form development chat. The task is only created
// on the first message (type nothing and nothing is created; closable anytime).
// When the agent hits a real decision point it emits an ```ask-user block → rendered as a decision card
// (clicking an option = the next message); clicking "open PR" lets the agent open it itself.
import { stripRecommendedMarker } from '~core/agent/decisionCard'

import { useRunHost, type Pending, type HostInfo, type PermissionMode, type RunSummary } from '../composables/useRunHost'

const props = defineProps<{ projectId: string; featureId: string | null }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ changed: []; created: [id: string]; deleted: [id: string] }>()
const { t, locale } = useI18n()
const toast = useToast()

type Turn = { id: string; role: 'user' | 'assistant'; content: string; status: string }
type Task = { id: string; title: string | null; description?: string; status: string; branch: string | null; prUrl: string | null; prNumber: number | null; error: string | null }
type Detail = { task: Task; turns: Turn[]; events?: { ts: string; kind: string; message: string | null }[]; busy: boolean; host?: HostInfo; pending?: Pending[]; run?: RunSummary }

const data = ref<Detail | null>(null)
const input = ref('')
const otherAnswer = ref('') // decision card "other…" free-text input
const liveAssistant = ref('')
const logLines = ref<string[]>([])
const { confirming } = useInlineConfirm() // '' | 'discard'
const busy = ref(false)
const sending = ref(false) // send/create/open-PR in flight: prevents duplicate dispatch (including double-clicking a decision card button)
let es: EventSource | null = null
// load race guard (same fix as in main): when switching tasks, a late in-flight load for the old task must not overwrite data.
let loadToken = 0
// Session host (shared with the fix panel / global drawer): native permission / question / plan cards, mode, context meter, cost.
function pushLog(line: string) {
  logLines.value.push(`${hhmmss()}  ${line}`)
  if (logLines.value.length > 300) logLines.value.shift()
}
const featureIdRef = computed(() => props.featureId)
const host = useRunHost(featureIdRef, { pushLog, notify })
const LS_MODE = 'mr.feature.mode'
watch(host.mode, (m) => { if (import.meta.client) localStorage.setItem(LS_MODE, m) })

// ultracode activated in the background + allow dangerous commands: persisted in localStorage (remembered across tasks/reloads), the prefix is injected by the backend.
const allowDanger = ref(false)
const ultracodeOn = ref(false)
const LS_DANGER = 'mr.feature.allowDanger'
const LS_ULTRA = 'mr.feature.ultracode'
onMounted(() => {
  allowDanger.value = localStorage.getItem(LS_DANGER) === '1'
  ultracodeOn.value = localStorage.getItem(LS_ULTRA) === '1'
  // A feature session edits code by design: bypassPermissions + the danger guard is the default, the user can tighten it per session.
  const m = localStorage.getItem(LS_MODE) as PermissionMode | null
  host.mode.value = m && ['default', 'acceptEdits', 'plan', 'bypassPermissions'].includes(m) ? m : 'bypassPermissions'
})
watch(allowDanger, (v) => {
  if (import.meta.client) localStorage.setItem(LS_DANGER, v ? '1' : '0')
  if (props.featureId) void host.setAllowDanger(v) // a live host session picks it up immediately
})
function toggleUltracode() {
  ultracodeOn.value = !ultracodeOn.value
  if (import.meta.client) localStorage.setItem(LS_ULTRA, ultracodeOn.value ? '1' : '0')
}

const task = computed(() => data.value?.task)
const status = computed(() => task.value?.status || '')
const running = computed(() => {
  const ts = data.value?.turns ?? []
  return data.value?.busy || (ts.length > 0 && ts[ts.length - 1]!.role === 'assistant' && ts[ts.length - 1]!.status === 'streaming')
})
const canChat = computed(() => !running.value && !busy.value && !sending.value)

const STATUS_CLS: Record<string, string> = {
  working: 'text-toned border-accented',
  awaiting: 'text-warning border-warning/40',
  opened: 'text-success border-success/40',
  error: 'text-error border-error/40',
}

// Decision card: the last assistant turn contains an ```ask-user block → parse out the question + options (shown only while the user hasn't answered yet).
// Any block renders a card (even with no options listed, the "other" free-text answer is there) — the question must never silently disappear.
const ASK_RE = /```ask-user\s*\n([\s\S]*?)```/i
const IS_OPT = /^(?:[-*]|\d+[.)])\s+/ // accepts - / * / 1. / 1) list styles
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
// Display: the turn currently rendered as a card drops the whole ask block (the card already shows it); other historical turns replace the block with the question text (so nothing is left blank).
function askQuestionText(inner: string): string {
  return inner.split('\n').map((l) => l.trim()).filter((l) => l && !IS_OPT.test(l)).join('\n')
}
function displayText(content: string, stripAsk: boolean): string {
  return content.replace(/```ask-user\s*\n([\s\S]*?)```/gi, (_m, inner) => (stripAsk ? '' : askQuestionText(inner))).trim()
}
// The recommended marker on option buttons is display-only; strip it when sending (the marker itself is defined in ~core/agent/decisionCard)
function optionLabel(o: string): string { return stripRecommendedMarker(o) }

function notify(msg: string, ok = false) { toast.add({ title: msg, color: ok ? 'success' : 'error', icon: ok ? 'i-lucide-check' : 'i-lucide-triangle-alert' }) }
function hhmmss(iso?: string) { return new Date(iso ?? new Date().toISOString()).toLocaleTimeString(locale.value, { hour12: false }) }

async function load() {
  const fid = props.featureId
  if (!fid) return
  const my = ++loadToken
  const detail = await $fetch<Detail>(`/api/features/${fid}`)
  if (my !== loadToken || fid !== props.featureId) return // stale result → discard
  data.value = detail
  host.applyDetail(detail)
  if (!logLines.value.length && detail.events?.length) {
    logLines.value = detail.events.filter((e) => e.message).map((e) => `${hhmmss(e.ts)}  ${e.message}`)
  }
  emit('changed')
}
function openSSE() {
  if (!props.featureId || !import.meta.client) return
  es?.close()
  const fid = props.featureId
  es = new EventSource(`/api/features/${fid}/stream`)
  es.onmessage = (ev) => {
    if (fid !== props.featureId) return // stale stream → ignore
    try {
      const e = JSON.parse(ev.data)
      if (e.kind === 'run') { host.onRunEvent(e.data); return }
      if (e.kind === 'text') { liveAssistant.value += e.message || ''; return }
      if (e.message) pushLog(e.message)
      if (['done', 'error', 'chat'].includes(e.kind)) { liveAssistant.value = ''; load() }
    } catch { /* ignore */ }
  }
}
function closeSSE() { es?.close(); es = null }

watch([open, () => props.featureId], () => {
  if (!open.value) { closeSSE(); return }
  // Opening / switching tasks / switching to the new id after creation: clear the previous leftovers first (otherwise the old task's content flashes before load returns)
  data.value = null; liveAssistant.value = ''; logLines.value = []; confirming.value = ''; otherAnswer.value = ''; host.reset()
  if (props.featureId) { load(); openSSE() } else closeSSE()
})
onBeforeUnmount(closeSSE)

// Polling backstop while a turn is in progress
let pollTimer: ReturnType<typeof setInterval> | null = null
watch([running, open], ([r, o]) => {
  if (r && o && !pollTimer) pollTimer = setInterval(load, 2500)
  else if ((!r || !o) && pollTimer) { clearInterval(pollTimer); pollTimer = null }
})
onBeforeUnmount(() => { if (pollTimer) clearInterval(pollTimer) })

const { scrollEl, scrollToBottom } = useScrollToBottom()
watch([() => data.value?.turns.length, liveAssistant, open], () => { if (open.value) scrollToBottom() })

// Send a message: new task (featureId=null) → the first message creates it and starts the run; otherwise → continue the chat. Returns whether the send succeeded.
async function sendChat(overrideMsg?: string): Promise<boolean> {
  const msg = (overrideMsg ?? input.value).trim()
  if (!msg || !canChat.value) return false
  if (overrideMsg == null) input.value = ''
  liveAssistant.value = ''
  sending.value = true
  try {
    if (!props.featureId) {
      const res = await $fetch<{ id: string }>(`/api/projects/${props.projectId}/features`, { method: 'POST', body: { description: msg, allowDanger: allowDanger.value, ultracode: ultracodeOn.value, permissionMode: host.mode.value } })
      emit('created', res.id) // the parent switches activeId to the new id → this drawer's featureId changes → the watch loads the running task
      return true
    }
    await $fetch(`/api/features/${props.featureId}/chat`, { method: 'POST', body: { message: msg, allowDanger: allowDanger.value, ultracode: ultracodeOn.value, permissionMode: host.mode.value } })
    await load()
    return true
  } catch (e: any) {
    if (overrideMsg == null) input.value = msg
    notify(e?.data?.statusMessage || t('common.failed'))
    return false
  } finally { sending.value = false }
}
// Decision card option / "other…" free-text answer (a failed send must not lose what the user typed)
function answer(opt: string) { void sendChat(optionLabel(opt)) }
function answerOther() { const v = otherAnswer.value.trim(); if (!v) return; sendChat(v).then((ok) => { if (ok) otherAnswer.value = '' }) }

// Open PR: send the agent a "please open a PR" message and let it commit/push/gh pr create itself (allowDanger force-allows the push).
async function openPr() {
  if (!props.featureId || !canChat.value) return
  liveAssistant.value = ''
  sending.value = true
  try {
    await $fetch(`/api/features/${props.featureId}/chat`, { method: 'POST', body: { message: t('feature.openPrMsg'), allowDanger: true, ultracode: ultracodeOn.value, permissionMode: host.mode.value } })
    await load()
  } catch (e: any) { notify(e?.data?.statusMessage || t('common.failed')) }
  finally { sending.value = false }
}

async function stop() {
  if (!props.featureId) return
  try { await $fetch(`/api/features/${props.featureId}/stop`, { method: 'POST' }); await load() }
  catch { /* ignore */ }
}
async function doDelete() {
  if (!props.featureId) { open.value = false; return }
  const id = props.featureId
  busy.value = true
  try {
    await $fetch(`/api/features/${id}`, { method: 'DELETE' })
    closeSSE()
    loadToken++
    data.value = null
    liveAssistant.value = ''
    logLines.value = []
    emit('deleted', id)
    emit('changed')
    open.value = false
  }
  catch (e: any) { notify(e?.data?.statusMessage || t('common.failed')) }
  finally { busy.value = false; confirming.value = '' }
}
</script>

<template>
  <USlideover v-model:open="open" :ui="{ content: 'w-[100vw] max-w-full min-w-0 md:w-[calc(100vw-15rem)] md:min-w-[640px] md:max-w-none' }">
    <template #content>
      <div class="h-full flex flex-col bg-default text-default">
        <!-- Top header: title + open on GitHub + ✕ (same as the PR detail drawer; the GitHub link sits right next to the X) -->
        <div class="shrink-0 flex items-center gap-3 px-6 py-4 border-b border-default">
          <h2 class="text-base font-medium truncate min-w-0 flex-1">{{ task ? (task.title || task.description || $t('feature.tab')) : $t('feature.newTitle') }}</h2>
          <a v-if="task?.prUrl" :href="task.prUrl" target="_blank" class="text-xs text-muted hover:text-highlighted whitespace-nowrap shrink-0">{{ $t('prDrawer.openInGithub') }}</a>
          <button class="text-dimmed hover:text-highlighted text-lg leading-none shrink-0" @click="open = false">✕</button>
        </div>

        <!-- body -->
        <div class="flex-1 min-h-0 flex flex-col px-6 py-4">
        <!-- Status + delete task (title / GitHub have moved up into the top header) -->
        <div v-if="task" class="shrink-0 flex items-center gap-2 pb-2 mb-2 border-b border-default">
          <span class="shrink-0 text-[10px] uppercase tracking-wider px-2 py-0.5 border rounded-full" :class="STATUS_CLS[status] || 'text-dimmed border-default'">{{ $t('feature.status.' + status) }}</span>
          <template v-if="confirming === 'discard'">
            <span class="ml-auto text-xs text-dimmed">{{ $t('feature.discardConfirm') }}</span>
            <button class="text-xs text-error font-medium hover:underline disabled:opacity-40" :disabled="busy" @click="doDelete">{{ $t('common.delete') }}</button>
            <button class="text-xs text-dimmed hover:text-highlighted" @click="confirming = ''">{{ $t('common.cancel') }}</button>
          </template>
          <button v-else class="ml-auto text-xs text-dimmed hover:text-highlighted disabled:opacity-40 shrink-0" :disabled="running || busy" @click="confirming = 'discard'">{{ $t('feature.discard') }}</button>
        </div>

        <!-- Run log (when there is a task) -->
        <ChatLogPanel v-if="featureId" :lines="logLines" />

        <!-- Scroll area: chat + decision card -->
        <div ref="scrollEl" class="flex-1 min-h-0 overflow-y-auto space-y-4 pr-1">
          <div v-if="featureId && !task" class="text-xs text-dimmed py-4">{{ $t('common.loading') }}</div>
          <div v-else-if="!featureId && !(data?.turns.length)" class="text-xs text-dimmed py-10 text-center leading-relaxed whitespace-pre-line">{{ $t('feature.newHint') }}</div>

          <div v-for="(turn, ti) in data?.turns ?? []" :key="turn.id" :class="turn.role === 'user' ? 'text-right' : ''">
            <div v-if="turn.role === 'user'" class="inline-block max-w-[92%] text-left text-sm rounded-lg px-3 py-2 whitespace-pre-wrap break-words bg-inverted text-inverted">{{ turn.content }}</div>
            <div v-else class="inline-block max-w-[92%] text-left text-sm rounded-lg px-3 py-2 break-words bg-muted">
              <!-- While streaming: plain text (avoids half-parsed markdown overlapping); once done: markdown (only the card's turn drops the ask block) -->
              <template v-if="turn.status === 'streaming' && ti === (data?.turns.length ?? 0) - 1">
                <!-- Take whichever is longer, liveAssistant or the persisted content: when the SSE connection is late liveAssistant only holds the tail, don't let it override the complete earlier part -->
                <span class="whitespace-pre-wrap break-words">{{ liveAssistant.length >= turn.content.length ? liveAssistant : turn.content }}</span>
                <span class="animate-pulse">▍</span>
              </template>
              <MarkdownBody v-else :text="displayText(turn.content, !!askCard && ti === (data?.turns.length ?? 0) - 1)" />
              <span v-if="turn.status === 'stopped'" class="text-[10px] text-dimmed ml-1">· {{ $t('fix.stoppedTag') }}</span>
            </div>
          </div>

          <div v-if="running" class="text-xs text-toned flex items-center gap-2">
            <span class="inline-block w-1.5 h-1.5 rounded-full bg-inverted animate-pulse" />{{ $t('feature.status.working') }}…
          </div>

          <!-- Native prompts from the session host: permission / question / plan -->
          <RunPromptCards :host="host" />

          <!-- Decision card (the agent is waiting for your call) -->
          <div v-if="askCard" class="rounded border border-inverted p-3 space-y-2">
            <div class="text-[10px] uppercase tracking-[0.15em] text-dimmed">{{ $t('feature.decisionTitle') }}</div>
            <p v-if="askCard.question" class="text-sm font-medium whitespace-pre-wrap">{{ askCard.question }}</p>
            <div v-if="askCard.options.length" class="flex flex-col gap-1.5">
              <button
                v-for="(o, i) in askCard.options" :key="i"
                class="text-left text-sm border border-default rounded px-3 py-1.5 hover:border-inverted hover:bg-elevated/40 disabled:opacity-40"
                :disabled="!canChat" @click="answer(o)"
              >{{ o }}</button>
            </div>
            <div class="flex items-center gap-2 pt-1">
              <input
                v-model="otherAnswer" :placeholder="$t('feature.decisionOther')"
                class="flex-1 text-sm border-b border-default focus:border-inverted outline-none py-1 bg-transparent"
                :disabled="!canChat" @keydown.enter="answerOther"
              />
              <button class="text-xs text-dimmed hover:text-highlighted disabled:opacity-40" :disabled="!canChat || !otherAnswer.trim()" @click="answerOther">{{ $t('global.send') }}</button>
            </div>
          </div>

          <p v-if="status === 'error' && task?.error" class="text-xs text-error">{{ task.error }}</p>
        </div>

        <!-- Actions + composer -->
        <div class="shrink-0 pt-3 mt-2 border-t border-default space-y-2">
          <div v-if="task" class="flex items-center gap-2 flex-wrap">
            <button
              class="text-sm bg-inverted text-inverted px-4 py-1.5 rounded hover:bg-inverted/90 disabled:opacity-40"
              :disabled="!canChat" @click="openPr"
            >{{ task.prUrl ? $t('feature.updatePr') : $t('feature.openPr') }}</button>
            <button v-if="running" class="text-sm border border-accented px-4 py-1.5 rounded hover:bg-muted ml-auto" @click="stop">{{ $t('fix.stop') }}</button>
          </div>
          <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
            <label class="flex items-center gap-2 cursor-pointer">
              <input v-model="allowDanger" type="checkbox" class="accent-error" />
              <span :class="allowDanger ? 'text-error' : 'text-dimmed'">{{ allowDanger ? $t('global.dangerOn') : $t('global.dangerOff') }}</span>
            </label>
            <RunHostStrip :host="host" :live="!!featureId" :tokens="data?.run" />
          </div>
          <textarea
            v-model="input" rows="2" :placeholder="featureId ? $t('feature.chatPlaceholder') : $t('feature.composerPlaceholder')"
            class="w-full text-sm border border-default rounded px-2 py-1.5 resize-y outline-none focus:border-inverted" :disabled="!canChat"
          />
          <div class="flex items-center justify-between gap-2">
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
            <button class="w-24 text-sm bg-inverted text-inverted py-1.5 rounded hover:bg-inverted/90 disabled:opacity-40" :disabled="!input.trim() || !canChat" @click="sendChat()">{{ sending && !featureId ? $t('feature.creating') : $t('global.send') }}</button>
          </div>
        </div>
        </div>
      </div>
    </template>
  </USlideover>
</template>

<style scoped>
/* ultracode button: the shine sweep only runs when active; inactive is gray with no sweep. */
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

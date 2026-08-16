<script setup lang="ts">
// Global do-anything assistant: floating button bottom-right + slideover. Native claude experience via bypassPermissions.
// The command palette (/clear /resume /copy /cd) is homegrown (headless has no native slash REPL).
import { stripRecommendedMarker } from '~core/agent/decisionCard'

const { t, locale } = useI18n()
const toast = useToast()
const route = useRoute()

type Turn = { id: string; role: 'user' | 'assistant'; content: string; status: string; seq: number }
type Session = { id: string; title: string | null; provider: string; cwd: string | null; status: string; error: string | null; lastUsedAt: string }
type Detail = { session: Session; turns: Turn[]; chatting: boolean }

const open = ref(false)
const sessionId = ref<string | null>(null)
const data = ref<Detail | null>(null)
const view = ref<'chat' | 'history'>('chat')
const input = ref('')
const liveAssistant = ref('')
const logLines = ref<string[]>([]) // tool/stage log (live; panel state lives inside ChatLogPanel)
const busy = ref(false)
// "allow dangerous commands" + "ultracode background activation": once turned on it is remembered forever
// (localStorage, across sessions/reloads), no need to re-click per message. ultracode no longer stuffs a prefix
// into the input box; the backend injects it when sending to the agent (you never see the prefix).
const allowDanger = ref(false)
const ultracodeOn = ref(false)
const LS_DANGER = 'mr.global.allowDanger'
const LS_ULTRA = 'mr.global.ultracode'
onMounted(() => {
  allowDanger.value = localStorage.getItem(LS_DANGER) === '1'
  ultracodeOn.value = localStorage.getItem(LS_ULTRA) === '1'
})
watch(allowDanger, (v) => { if (import.meta.client) localStorage.setItem(LS_DANGER, v ? '1' : '0') })
function toggleUltracode() {
  ultracodeOn.value = !ultracodeOn.value
  if (import.meta.client) localStorage.setItem(LS_ULTRA, ultracodeOn.value ? '1' : '0')
}
const { confirming } = useInlineConfirm() // '' | 'delete' (inline confirm inside the slideover, no modal)
const renaming = ref(false)
const renameVal = ref('')
let es: EventSource | null = null
// load race guard (same as FeatureDrawer): when switching sessions / starting a new chat, a late in-flight load from the previous session must not overwrite data.
let loadToken = 0

const currentProjectId = computed(() => {
  if (!route.path.startsWith('/projects/')) return undefined
  const id = route.params.id
  return typeof id === 'string' && id.trim() ? id : undefined
})

const chatting = computed(() => {
  const ts = data.value?.turns ?? []
  return ts.length > 0 && ts[ts.length - 1]!.role === 'assistant' && ts[ts.length - 1]!.status === 'streaming'
})

function notify(msg: string, ok = false) {
  toast.add({ title: msg, color: ok ? 'success' : 'error', icon: ok ? 'i-lucide-check' : 'i-lucide-triangle-alert' })
}

// ── session lifecycle ──
async function ensureSession(): Promise<string> {
  if (sessionId.value) return sessionId.value
  const s = await $fetch<Session>('/api/global/sessions', { method: 'POST', body: { projectId: currentProjectId.value } })
  sessionId.value = s.id
  data.value = { session: s, turns: [], chatting: false }
  openSSE()
  return s.id
}
async function load() {
  const sid = sessionId.value
  if (!sid) return
  const my = ++loadToken
  const detail = await $fetch<Detail>(`/api/global/sessions/${sid}`)
  if (my !== loadToken || sid !== sessionId.value) return // stale result (session switched / a newer load exists) → discard
  data.value = detail
}
// New chat = reset to blank; don't create a session right away (lazy: only the first message persists it, so opening doesn't spawn an "untitled chat").
function newSession() {
  closeSSE()
  sessionId.value = null
  data.value = null
  liveAssistant.value = ''
  logLines.value = []
  view.value = 'chat'
  confirming.value = ''
}
async function deleteSession() {
  if (!sessionId.value) { confirming.value = ''; return }
  await $fetch(`/api/global/sessions/${sessionId.value}`, { method: 'DELETE' }).catch(() => {})
  newSession()
}
// Rename (click the title to edit in place + PATCH)
async function saveRename() {
  const title = renameVal.value.trim()
  renaming.value = false
  if (!sessionId.value || !title || !data.value) return
  data.value.session.title = title
  await $fetch(`/api/global/sessions/${sessionId.value}`, { method: 'PATCH', body: { title } }).catch(() => {})
}

// ── SSE ──
function openSSE() {
  if (!sessionId.value || !import.meta.client) return
  es?.close()
  const sid = sessionId.value // bind this stream to its session: leftover messages no longer land after a session switch
  es = new EventSource(`/api/global/sessions/${sid}/stream`)
  es.onmessage = (ev) => {
    if (sid !== sessionId.value) return // stale stream → ignore
    try {
      const e = JSON.parse(ev.data)
      if (e.kind === 'text') { liveAssistant.value += e.message || ''; return }
      // tool/stage events → collect into the log panel (same as fix)
      if (e.message && e.kind !== 'chat') { logLines.value.push(`${hhmmss(e.ts)}  ${e.message}`); if (logLines.value.length > 300) logLines.value.shift() }
      if (['done', 'error', 'chat'].includes(e.kind)) { liveAssistant.value = ''; load() }
    } catch { /* ignore */ }
  }
}
function closeSSE() { es?.close(); es = null }

watch(open, (on) => {
  // Lazy creation: opening the slideover doesn't create a session; only load when one already exists. A new chat is created by the first message.
  if (on) { confirming.value = ''; logLines.value = []; if (sessionId.value) { load(); openSSE() } }
  else closeSSE()
})
onBeforeUnmount(() => { closeSSE(); if (timer) clearInterval(timer) })

// auto-scroll to bottom + elapsed timer while a turn is running
const { scrollEl, scrollToBottom } = useScrollToBottom()
watch([() => data.value?.turns.length, liveAssistant, open], () => { if (open.value) scrollToBottom() })
const elapsed = ref(0)
let timer: ReturnType<typeof setInterval> | null = null
watch(chatting, (on) => {
  if (timer) { clearInterval(timer); timer = null }
  if (on) { elapsed.value = 0; timer = setInterval(() => { elapsed.value++ }, 1000) }
  else load() // backstop refresh when the turn ends
})

// Decision card (same as feature/fix): the last assistant turn contains an ```ask-user block → question + options; clicking an option sends it as the next message (free-form answers use the input box).
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
function answer(opt: string) {
  if (chatting.value || busy.value) return
  input.value = stripRecommendedMarker(opt) // the recommended marker is display-only (defined in ~core/agent/decisionCard)
  send(true) // bypass the slash interception
}

// ── command palette (homegrown) ──
const COMMANDS = [
  { cmd: '/clear', desc: () => t('global.cmd.clear') },
  { cmd: '/resume', desc: () => t('global.cmd.resume') },
  { cmd: '/copy', desc: () => t('global.cmd.copy') },
  { cmd: '/cd', desc: () => t('global.cmd.cd') },
]
const slashOpen = computed(() => input.value.startsWith('/') && !input.value.includes('\n'))
const slashMatches = computed(() => {
  if (!slashOpen.value) return []
  const head = input.value.split(/\s/)[0]!.toLowerCase()
  return COMMANDS.filter((c) => c.cmd.startsWith(head))
})

function lastAssistantText(): string {
  const ts = data.value?.turns ?? []
  for (let i = ts.length - 1; i >= 0; i--) if (ts[i]!.role === 'assistant') return ts[i]!.content
  return ''
}

// returns true = handled as a command (not sent as a normal message)
async function handleSlash(raw: string): Promise<boolean> {
  const [cmd, ...rest] = raw.trim().split(/\s+/)
  const arg = rest.join(' ')
  switch (cmd) {
    case '/clear': input.value = ''; await newSession(); return true
    case '/resume': input.value = ''; view.value = 'history'; await loadHistory(); return true
    case '/copy': {
      input.value = ''
      const txt = lastAssistantText()
      if (txt && import.meta.client) { await navigator.clipboard.writeText(txt).catch(() => {}); notify(t('global.copied'), true) }
      return true
    }
    case '/cd': {
      if (!arg) return false // "/cd <path>" needs an argument; without one, treat it as ordinary input
      input.value = ''
      pendingCwd.value = arg
      notify(t('global.cdSet', { path: arg }), true)
      return true
    }
    default: return false
  }
}

const pendingCwd = ref<string | null>(null)

async function send(skipSlash = false) {
  const msg = input.value.trim()
  if (!msg || chatting.value || busy.value) return
  // commands take priority (decision-card answers pass skipSlash so option text starting with something like /clear isn't swallowed as a command)
  if (!skipSlash && msg.startsWith('/') && await handleSlash(msg)) return
  input.value = ''
  liveAssistant.value = ''
  try {
    const id = await ensureSession()
    await $fetch(`/api/global/sessions/${id}/chat`, { method: 'POST', body: { message: msg, cwd: pendingCwd.value || undefined, allowDanger: allowDanger.value, ultracode: ultracodeOn.value, projectId: currentProjectId.value } })
    pendingCwd.value = null
    await load()
  } catch (e: any) {
    input.value = msg
    notify(e?.data?.statusMessage || t('common.failed'))
  }
}
async function stop() {
  if (!sessionId.value) return
  try { await $fetch(`/api/global/sessions/${sessionId.value}/stop`, { method: 'POST' }); await load() }
  catch (e: any) { notify(e?.data?.statusMessage || t('common.failed')) }
}

// ── history ──
type HistResp = { sessions: Session[]; total: number; page: number; pageSize: number; hasNext: boolean }
const hist = ref<HistResp | null>(null)
const histPage = ref(0)
async function loadHistory() {
  hist.value = await $fetch<HistResp>('/api/global/sessions', { query: { page: histPage.value, pageSize: 12 } })
}
async function openHistorySession(id: string) {
  closeSSE()
  // clear the previous session's leftovers (turns/streaming text/log) first, otherwise the old content flashes before load returns
  data.value = null; liveAssistant.value = ''; logLines.value = []
  sessionId.value = id
  view.value = 'chat'
  await load()
  openSSE()
}
function histPrev() { if (histPage.value > 0) { histPage.value--; loadHistory() } }
function histNext() { if (hist.value?.hasNext) { histPage.value++; loadHistory() } }

function fmtTime(iso: string) { return new Date(iso).toLocaleString(locale.value, { hour12: false }) }
function hhmmss(iso?: string) { return new Date(iso ?? new Date().toISOString()).toLocaleTimeString(locale.value, { hour12: false }) }
</script>

<template>
  <!-- Floating button bottom-right: black circle + white icon (chat bubble + sparkle) -->
  <button
    class="fixed bottom-6 right-6 z-50 w-12 h-12 rounded-full bg-neutral-900 text-white shadow-lg flex items-center justify-center hover:scale-105 active:scale-95 transition-transform"
    :title="$t('global.fabTitle')"
    @click="open = true"
  >
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor"
         stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <path d="M20 12a8 8 0 0 1-11.3 7.3L4 20l.9-4.2A8 8 0 1 1 20 12Z" />
      <path d="M12 8.3l.95 2.25 2.25.95-2.25.95L12 14.7l-.95-2.25L8.8 11.5l2.25-.95L12 8.3Z" fill="currentColor" stroke="none" />
    </svg>
  </button>

  <USlideover v-model:open="open" :title="$t('global.title')" :ui="{ content: 'w-[100vw] max-w-full min-w-0 md:w-[calc(100vw-15rem)] md:min-w-[640px] md:max-w-none' }">
    <template #body>
      <div class="flex flex-col h-full min-h-0">
        <!-- Header: session controls + editable title + cwd -->
        <div class="shrink-0 flex items-center gap-2 pb-2 mb-2 border-b border-default text-xs">
          <button class="px-2 py-1 rounded border border-default hover:bg-muted" @click="newSession">{{ $t('global.newSession') }}</button>
          <button class="px-2 py-1 rounded border border-default hover:bg-muted" :class="view === 'history' ? 'bg-muted text-highlighted' : ''" @click="view = 'history'; loadHistory()">{{ $t('global.history') }}</button>
          <!-- Editable title (click to rename) -->
          <input
            v-if="renaming" v-model="renameVal" class="flex-1 min-w-0 text-xs border-b border-inverted outline-none bg-transparent py-0.5"
            :placeholder="$t('global.untitled')" @keydown.enter="saveRename" @blur="saveRename"
          />
          <button
            v-else-if="sessionId" class="flex-1 min-w-0 truncate text-left text-dimmed hover:text-highlighted"
            :title="$t('global.rename')" @click="renameVal = data?.session.title || ''; renaming = true"
          >{{ data?.session.title || $t('global.untitled') }}</button>
          <!-- Delete: inline confirm inside the slideover (no modal) -->
          <template v-if="confirming === 'delete'">
            <span class="text-dimmed">{{ $t('global.confirmDelete') }}</span>
            <button class="text-error font-medium hover:underline" @click="deleteSession">{{ $t('common.delete') }}</button>
            <button class="text-dimmed hover:text-highlighted" @click="confirming = ''">{{ $t('common.cancel') }}</button>
          </template>
          <button v-else-if="sessionId" class="px-2 py-1 rounded border border-default text-error hover:bg-muted shrink-0" @click="confirming = 'delete'">{{ $t('common.delete') }}</button>
          <span v-if="data?.session.cwd" class="font-mono text-dimmed truncate max-w-[14rem] shrink-0" :title="data.session.cwd">{{ data.session.cwd }}</span>
        </div>
        <label class="shrink-0 flex items-center gap-2 text-[11px] mb-2 cursor-pointer">
          <input v-model="allowDanger" type="checkbox" class="accent-error" />
          <span :class="allowDanger ? 'text-error' : 'text-dimmed'">{{ allowDanger ? $t('global.dangerOn') : $t('global.dangerOff') }}</span>
        </label>

        <!-- Run log (tool calls / stages, expandable; same as fix) -->
        <ChatLogPanel v-if="view === 'chat'" :lines="logLines" />

        <!-- History list -->
        <div v-if="view === 'history'" class="flex-1 min-h-0 overflow-y-auto">
          <div v-if="!hist?.sessions.length" class="text-xs text-dimmed py-8 text-center">{{ $t('global.historyEmpty') }}</div>
          <button
            v-for="s in hist?.sessions ?? []" :key="s.id"
            class="w-full text-left px-3 py-2 rounded border border-default hover:border-accented mb-1.5"
            @click="openHistorySession(s.id)"
          >
            <div class="text-sm truncate">{{ s.title || $t('global.untitled') }}</div>
            <div class="text-[11px] text-dimmed flex gap-2"><span>{{ fmtTime(s.lastUsedAt) }}</span><span class="font-mono">{{ s.provider }}</span></div>
          </button>
          <div v-if="hist && hist.total > hist.pageSize" class="flex items-center justify-between text-xs text-dimmed mt-2">
            <button class="hover:text-highlighted disabled:opacity-30" :disabled="histPage === 0" @click="histPrev">{{ $t('project.pagination.prev') }}</button>
            <span>{{ hist.page + 1 }}</span>
            <button class="hover:text-highlighted disabled:opacity-30" :disabled="!hist.hasNext" @click="histNext">{{ $t('project.pagination.next') }}</button>
          </div>
        </div>

        <!-- Chat -->
        <template v-else>
          <div ref="scrollEl" class="flex-1 min-h-0 overflow-y-auto space-y-3 pr-1">
            <div v-if="!data?.turns.length" class="text-xs text-dimmed py-10 text-center">{{ $t('global.empty') }}</div>
            <div v-for="(turn, ti) in data?.turns ?? []" :key="turn.id" :class="turn.role === 'user' ? 'text-right' : ''">
              <!-- user: plain-text bubble -->
              <div v-if="turn.role === 'user'" class="inline-block max-w-[90%] text-left text-sm rounded-lg px-3 py-2 whitespace-pre-wrap break-words bg-inverted text-inverted">{{ turn.content }}</div>
              <!-- assistant: rendered markdown -->
              <div v-else class="inline-block max-w-[90%] text-left text-sm rounded-lg px-3 py-2 break-words bg-muted">
                <MarkdownBody :text="turn.status === 'streaming' && ti === (data?.turns.length ?? 0) - 1 && liveAssistant ? liveAssistant : displayText(turn.content, !!askCard && ti === (data?.turns.length ?? 0) - 1)" />
                <span v-if="turn.status === 'streaming'" class="animate-pulse">▍</span>
                <span v-if="turn.status === 'stopped'" class="text-[10px] text-dimmed ml-1">· {{ $t('fix.stoppedTag') }}</span>
              </div>
            </div>
            <!-- Decision card (the agent is waiting on you; same as feature/fix). Free-form answers use the input box below. -->
            <div v-if="askCard" class="rounded border border-inverted p-3 space-y-2 text-left">
              <div class="text-[10px] uppercase tracking-[0.15em] text-dimmed">{{ $t('feature.decisionTitle') }}</div>
              <p v-if="askCard.question" class="text-sm font-medium whitespace-pre-wrap">{{ askCard.question }}</p>
              <div v-if="askCard.options.length" class="flex flex-col gap-1.5">
                <button v-for="(o, i) in askCard.options" :key="i" class="text-left text-sm border border-default rounded px-3 py-1.5 hover:border-inverted hover:bg-elevated/40 disabled:opacity-40" :disabled="chatting || busy" @click="answer(o)">{{ o }}</button>
              </div>
            </div>
            <div v-if="chatting" class="text-xs text-toned flex items-center gap-2">
              <span class="inline-block w-1.5 h-1.5 rounded-full bg-inverted animate-pulse" />{{ $t('global.thinking') }}… {{ elapsed }}s
            </div>
            <p v-if="data?.session.status === 'error' && data.session.error" class="text-xs text-error">{{ data.session.error }}</p>
          </div>

          <!-- composer + command palette -->
          <div class="shrink-0 relative pt-2 mt-2 border-t border-default">
            <div v-if="slashMatches.length" class="absolute bottom-full left-0 mb-1 w-full bg-default border border-default rounded shadow-lg overflow-hidden">
              <div v-for="c in slashMatches" :key="c.cmd" class="flex items-center justify-between gap-3 px-3 py-1.5 text-xs hover:bg-muted cursor-pointer" @click="input = c.cmd + ' '">
                <span class="font-mono text-highlighted">{{ c.cmd }}</span>
                <span class="text-dimmed truncate">{{ c.desc() }}</span>
              </div>
            </div>
            <span v-if="pendingCwd" class="block text-[11px] text-dimmed mb-1">{{ $t('global.cdPending', { path: pendingCwd }) }}</span>
            <textarea
              v-model="input" rows="2" :placeholder="$t('global.placeholder')"
              class="w-full text-sm border border-default rounded px-2 py-1.5 resize-y outline-none focus:border-inverted"
            />
            <div class="flex items-center justify-between gap-2 mt-1.5">
              <!-- ultracode background-activation toggle: off = grey gradient (no shine), on = purple gradient + shine. One click is remembered forever, no need to click per message. -->
              <button
                type="button"
                class="ultra-btn relative overflow-hidden shrink-0 text-xs rounded px-2.5 py-1.5 font-medium text-white shadow-sm transition"
                :class="ultracodeOn ? 'is-active bg-gradient-to-r from-purple-600 to-fuchsia-600 ring-2 ring-purple-300' : 'bg-gradient-to-r from-neutral-500 to-neutral-600 opacity-80 hover:opacity-100'"
                :title="$t('global.ultracodeHint')"
                :aria-pressed="ultracodeOn"
                @click="toggleUltracode"
              >
                <span class="relative z-10 flex items-center gap-1">
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true">
                    <path d="M12 3l1.6 3.9L17.5 8.5l-3.9 1.6L12 14l-1.6-3.9L6.5 8.5l3.9-1.6L12 3Z" />
                  </svg>
                  {{ $t('global.ultracode') }}
                </span>
              </button>
              <button v-if="chatting" class="w-24 text-sm border border-accented rounded py-1.5 hover:bg-muted" @click="stop">{{ $t('fix.stop') }}</button>
              <button v-else class="w-24 text-sm bg-inverted text-inverted rounded py-1.5 hover:bg-inverted/90 disabled:opacity-40" :disabled="!input.trim() || busy" @click="send()">{{ $t('global.send') }}</button>
            </div>
          </div>
        </template>
      </div>
    </template>
  </USlideover>
</template>

<style scoped>
/* ultracode button: only the active state gets a highlight sweeping left to right (with a pause between sweeps); inactive is grey and doesn't sweep. */
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

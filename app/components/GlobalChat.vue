<script setup lang="ts">
// 全局「啥都能干」助手:右下角悬浮按钮 + 抽屉。bypassPermissions 原生 claude 体验。
// 命令面板(/clear /resume /copy /cd)是自建的(headless 没有原生 slash REPL)。
const { t, locale } = useI18n()
const toast = useToast()

type Turn = { id: string; role: 'user' | 'assistant'; content: string; status: string; seq: number }
type Session = { id: string; title: string | null; provider: string; cwd: string | null; status: string; error: string | null; lastUsedAt: string }
type Detail = { session: Session; turns: Turn[]; chatting: boolean }

const open = ref(false)
const sessionId = ref<string | null>(null)
const data = ref<Detail | null>(null)
const view = ref<'chat' | 'history'>('chat')
const input = ref('')
const liveAssistant = ref('')
const logLines = ref<string[]>([]) // 工具/阶段日志（实时；面板状态在 ChatLogPanel 内部）
const busy = ref(false)
// 「允许危险命令」+「ultracode 后台激活」：一次开启后永久记住（localStorage，跨会话/刷新），
// 不再每条消息重点。ultracode 不再往输入框塞前缀，改由后端在发给 agent 时注入（你永远看不到前缀）。
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
const { confirming } = useInlineConfirm() // '' | 'delete'（抽屉内联确认，不用弹窗）
const renaming = ref(false)
const renameVal = ref('')
let es: EventSource | null = null
// load 竞态护栏（同 FeatureDrawer）：切会话 / 新对话时，上一个会话在途的 load 迟到返回不能盖回 data。
let loadToken = 0

const chatting = computed(() => {
  const ts = data.value?.turns ?? []
  return ts.length > 0 && ts[ts.length - 1]!.role === 'assistant' && ts[ts.length - 1]!.status === 'streaming'
})

function notify(msg: string, ok = false) {
  toast.add({ title: msg, color: ok ? 'success' : 'error', icon: ok ? 'i-lucide-check' : 'i-lucide-triangle-alert' })
}

// ── session 生命周期 ──
async function ensureSession(): Promise<string> {
  if (sessionId.value) return sessionId.value
  const s = await $fetch<Session>('/api/global/sessions', { method: 'POST', body: {} })
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
  if (my !== loadToken || sid !== sessionId.value) return // 过期结果（切了会话 / 有更新的 load）→ 丢弃
  data.value = detail
}
// 新对话 = 清空到空白；不立刻建 session（懒创建：第一条消息才落库，避免一打开就冒「未命名对话」）。
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
// 重命名（点标题就地编辑 + PATCH）
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
  const sid = sessionId.value // 绑定这条流所属会话：切会话后残留消息不再写入
  es = new EventSource(`/api/global/sessions/${sid}/stream`)
  es.onmessage = (ev) => {
    if (sid !== sessionId.value) return // 过期流 → 忽略
    try {
      const e = JSON.parse(ev.data)
      if (e.kind === 'text') { liveAssistant.value += e.message || ''; return }
      // 工具/阶段事件 → 收进日志面板（同 fix）
      if (e.message && e.kind !== 'chat') { logLines.value.push(`${hhmmss(e.ts)}  ${e.message}`); if (logLines.value.length > 300) logLines.value.shift() }
      if (['done', 'error', 'chat'].includes(e.kind)) { liveAssistant.value = ''; load() }
    } catch { /* ignore */ }
  }
}
function closeSSE() { es?.close(); es = null }

watch(open, (on) => {
  // 懒创建：打开抽屉不建 session；有历史 session 才加载。新对话由第一条消息触发创建。
  if (on) { confirming.value = ''; logLines.value = []; if (sessionId.value) { load(); openSSE() } }
  else closeSSE()
})
onBeforeUnmount(() => { closeSSE(); if (timer) clearInterval(timer) })

// 自动滚到底 + 进行中计时
const { scrollEl, scrollToBottom } = useScrollToBottom()
watch([() => data.value?.turns.length, liveAssistant, open], () => { if (open.value) scrollToBottom() })
const elapsed = ref(0)
let timer: ReturnType<typeof setInterval> | null = null
watch(chatting, (on) => {
  if (timer) { clearInterval(timer); timer = null }
  if (on) { elapsed.value = 0; timer = setInterval(() => { elapsed.value++ }, 1000) }
  else load() // 轮结束兜底刷新
})

// 决策卡（同 feature/fix）：最后一条 assistant 轮含 ```ask-user 块 → 问题+选项；点选项=下一条消息（自由回答用输入框）。
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
  input.value = opt.replace(/\s*[（(]\s*推荐\s*[)）]\s*$/i, '')
  send(true) // 绕开 slash 拦截
}

// ── 命令面板(自建)──
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

// 返回 true = 已作为命令处理(不再当普通消息发)
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
      if (!arg) return false // 「/cd <路径>」需要参数,没给就当普通输入
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
  // 命令优先（决策卡回答走 skipSlash：选项文本万一以 /clear 之类开头别被当命令吞掉）
  if (!skipSlash && msg.startsWith('/') && await handleSlash(msg)) return
  input.value = ''
  liveAssistant.value = ''
  try {
    const id = await ensureSession()
    await $fetch(`/api/global/sessions/${id}/chat`, { method: 'POST', body: { message: msg, cwd: pendingCwd.value || undefined, allowDanger: allowDanger.value, ultracode: ultracodeOn.value } })
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

// ── 历史 ──
type HistResp = { sessions: Session[]; total: number; page: number; pageSize: number; hasNext: boolean }
const hist = ref<HistResp | null>(null)
const histPage = ref(0)
async function loadHistory() {
  hist.value = await $fetch<HistResp>('/api/global/sessions', { query: { page: histPage.value, pageSize: 12 } })
}
async function openHistorySession(id: string) {
  closeSSE()
  // 先清上一个会话的残留（对话/流式文字/日志），否则 load 返回前会闪出旧会话内容
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
  <!-- 右下角悬浮按钮:黑圆 + 白 icon(对话气泡+闪光) -->
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
        <!-- 顶部:session 控件 + 可编辑标题 + cwd -->
        <div class="shrink-0 flex items-center gap-2 pb-2 mb-2 border-b border-default text-xs">
          <button class="px-2 py-1 rounded border border-default hover:bg-muted" @click="newSession">{{ $t('global.newSession') }}</button>
          <button class="px-2 py-1 rounded border border-default hover:bg-muted" :class="view === 'history' ? 'bg-muted text-highlighted' : ''" @click="view = 'history'; loadHistory()">{{ $t('global.history') }}</button>
          <!-- 可编辑标题（点一下改名）-->
          <input
            v-if="renaming" v-model="renameVal" class="flex-1 min-w-0 text-xs border-b border-inverted outline-none bg-transparent py-0.5"
            :placeholder="$t('global.untitled')" @keydown.enter="saveRename" @blur="saveRename"
          />
          <button
            v-else-if="sessionId" class="flex-1 min-w-0 truncate text-left text-dimmed hover:text-highlighted"
            :title="$t('global.rename')" @click="renameVal = data?.session.title || ''; renaming = true"
          >{{ data?.session.title || $t('global.untitled') }}</button>
          <!-- 删除：抽屉内联确认（不用弹窗）-->
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

        <!-- 运行日志（工具调用 / 阶段，可展开；同 fix）-->
        <ChatLogPanel v-if="view === 'chat'" :lines="logLines" />

        <!-- 历史列表 -->
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

        <!-- 对话 -->
        <template v-else>
          <div ref="scrollEl" class="flex-1 min-h-0 overflow-y-auto space-y-3 pr-1">
            <div v-if="!data?.turns.length" class="text-xs text-dimmed py-10 text-center">{{ $t('global.empty') }}</div>
            <div v-for="(turn, ti) in data?.turns ?? []" :key="turn.id" :class="turn.role === 'user' ? 'text-right' : ''">
              <!-- user：纯文本气泡 -->
              <div v-if="turn.role === 'user'" class="inline-block max-w-[90%] text-left text-sm rounded-lg px-3 py-2 whitespace-pre-wrap break-words bg-inverted text-inverted">{{ turn.content }}</div>
              <!-- assistant：markdown 渲染 -->
              <div v-else class="inline-block max-w-[90%] text-left text-sm rounded-lg px-3 py-2 break-words bg-muted">
                <MarkdownBody :text="turn.status === 'streaming' && ti === (data?.turns.length ?? 0) - 1 && liveAssistant ? liveAssistant : displayText(turn.content, !!askCard && ti === (data?.turns.length ?? 0) - 1)" />
                <span v-if="turn.status === 'streaming'" class="animate-pulse">▍</span>
                <span v-if="turn.status === 'stopped'" class="text-[10px] text-dimmed ml-1">· {{ $t('fix.stoppedTag') }}</span>
              </div>
            </div>
            <!-- 决策卡（agent 在等你拍板；同 feature/fix）。自由回答用下方输入框。 -->
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

          <!-- composer + 命令面板 -->
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
              <!-- ultracode 后台激活开关：未激活=灰渐变(无扫光)，激活=紫渐变+扫光。点一次永久记住，不再每条都点。 -->
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
/* ultracode 按钮：激活态才有一束高光从左到右扫过（扫完停一下再来）；未激活是灰的、不扫光。*/
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

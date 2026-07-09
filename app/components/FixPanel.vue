<script setup lang="ts">
// 「修复 PR」面板（纯对话版）：点进来就是一个常驻对话框，和 Claude 在 PR 的 worktree 里聊、让它直接改代码。
// 不自动 commit；点「提交并上传」跳到预览 view（待上传 diff + 生成的 commit message，可改）→ 确认才 commit+push。
// 布局：自身 flex 撑满抽屉 fix tab 高度——对话流区域内部滚动，输入条固定钉在最底。
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
}

const currentFixId = ref<string | null>(props.fixId)
watch(() => props.fixId, (v) => { currentFixId.value = v })

const data = ref<FixData | null>(null)
const busy = ref('') // '' | 'discard' | 'rmwt' | 'upload'
const view = ref<'chat' | 'preview'>('chat')
const logLines = ref<string[]>([]) // 运行日志（worktree 准备 / 工具调用 / 阶段等），可展开
const showLog = ref(false)
let es: EventSource | null = null
// load 竞态护栏（同 FeatureDrawer）：切 fix / 放弃时，旧 fix 在途的 load 迟到返回不能盖回 data。
let loadToken = 0

// 允许危险命令 + ultracode 后台激活：localStorage 持久（跨 PR/刷新，同 feature/global）；前缀后端注入。
const allowDanger = ref(false)
const ultracodeOn = ref(false)
const LS_DANGER = 'mr.fix.allowDanger'
const LS_ULTRA = 'mr.fix.ultracode'
onMounted(() => {
  allowDanger.value = localStorage.getItem(LS_DANGER) === '1'
  ultracodeOn.value = localStorage.getItem(LS_ULTRA) === '1'
})
watch(allowDanger, (v) => { if (import.meta.client) localStorage.setItem(LS_DANGER, v ? '1' : '0') })
function toggleUltracode() {
  ultracodeOn.value = !ultracodeOn.value
  if (import.meta.client) localStorage.setItem(LS_ULTRA, ultracodeOn.value ? '1' : '0')
}

// 决策卡（同 FeatureDrawer）：最后一条 assistant 轮含 ```ask-user 块 → 问题+选项；点选项=下一条消息。
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
function optionLabel(o: string): string { return o.replace(/\s*[（(]\s*推荐\s*[)）]\s*$/i, '') }

function hhmmss(iso?: string) {
  return new Date(iso ?? new Date().toISOString()).toLocaleTimeString(locale.value, { hour12: false })
}

const toast = useToast()
function notify(msg: string, ok = false) {
  toast.add({ title: msg, color: ok ? 'success' : 'error', icon: ok ? 'i-lucide-check' : 'i-lucide-triangle-alert' })
}

// 对话进行中 = 最后一条 assistant 轮还在 streaming
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
  if (my !== loadToken || fid !== currentFixId.value) return // 过期结果（切了 fix / 有更新的 load）→ 丢弃
  data.value = detail
  // 首次：用落库的历史事件回填运行日志
  if (!logLines.value.length && detail.events?.length) {
    logLines.value = detail.events.filter((e) => e.message).map((e) => `${hhmmss(e.ts)}  ${e.message}`)
  }
  emit('changed')
}
function openSSE() {
  if (!currentFixId.value || !import.meta.client) return
  es?.close()
  const fid = currentFixId.value // 绑定这条流所属 fix：切走后残留消息不再写入
  es = new EventSource(`/api/fixes/${fid}/stream`)
  es.onmessage = (ev) => {
    if (fid !== currentFixId.value) return // 过期流 → 忽略
    try {
      const e = JSON.parse(ev.data)
      if (e.kind === 'text') { liveAssistant.value += e.message || ''; return }
      if (e.message) {
        logLines.value.push(`${hhmmss()}  ${e.message}`)
        if (logLines.value.length > 300) logLines.value.shift()
      }
      if (['done', 'status', 'error', 'chat'].includes(e.kind)) { liveAssistant.value = ''; load() }
    } catch {}
  }
  es.onopen = () => { if (data.value) load() }
}
function closeSSE() { es?.close(); es = null }

// tab 激活时连 SSE / load；切走时断开。切回 tab 总是回到对话视图。load 完滚到底（看最新一条）。
watch(() => [props.active, currentFixId.value] as const, async ([on, id]) => {
  if (on) {
    view.value = 'chat'
    if (id) { await load(); openSSE(); scrollChatToBottom() } else { data.value = null; closeSSE() }
  } else { closeSSE() }
}, { immediate: true })
onBeforeUnmount(() => { closeSSE(); if (chatTimer) clearInterval(chatTimer); if (pollTimer) clearInterval(pollTimer) })

// ── 对话 ──
const chatInput = ref('')
const liveAssistant = ref('')

// 进对话 / 来新消息时自动滚到最底
const chatScroll = ref<HTMLElement | null>(null)
function scrollChatToBottom() {
  const go = () => { const el = chatScroll.value; if (el) el.scrollTop = el.scrollHeight }
  // 二次补滚：MarkdownBody 渲染后内容高度可能再变（首次滚不到真正的底）
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
    // 惰性创建：还没有 fix 行就先建一个（不跑验证），再发第一条
    if (!currentFixId.value) {
      const res = await $fetch<{ id: string }>(`/api/projects/${props.projectId}/pulls/${props.prNumber}/fix`, { method: 'POST' })
      currentFixId.value = res.id
      emit('changed')
      openSSE()
    }
    await $fetch(`/api/fixes/${currentFixId.value}/chat`, { method: 'POST', body: { message: msg, allowDanger: allowDanger.value, ultracode: ultracodeOn.value } })
    await load()
    return true
  } catch (e: any) {
    if (overrideMsg == null) chatInput.value = msg
    notify(e?.data?.statusMessage || t('common.failed'))
    return false
  }
}
// 决策卡选项 / 「其它…」自由回答（发失败不丢用户手打的文本）
function answer(opt: string) { void sendChat(optionLabel(opt)) }
function answerOther() { const v = otherAnswer.value.trim(); if (!v) return; sendChat(v).then((ok) => { if (ok) otherAnswer.value = '' }) }
async function stopChat() {
  try { await $fetch(`/api/fixes/${currentFixId.value}/stop`, { method: 'POST' }); await load() }
  catch (e: any) { notify(e?.data?.statusMessage || t('common.failed')) }
}

// ── 提交并上传：预览 view ──
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

// ── 放弃任务 / 删工作区 ──
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
  try { await navigator.clipboard.writeText(p); notify(t('fix.pathCopied'), true) } catch { /* 忽略 */ }
}
</script>

<template>
  <div class="flex flex-col min-h-0 flex-1">
    <!-- ── 预览 view：待上传 diff + 可编辑 commit message ── -->
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

    <!-- ── 对话 view ── -->
    <template v-else>
      <!-- 头（固定）：状态 + 统计 + 放弃 + 出错横幅 -->
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

      <!-- 对话流（滚动区） -->
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

        <!-- 决策卡（agent 在等你拍板；同 feature 开发）-->
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

        <!-- 对话进行中：活动指示（步骤详情看上方「展开日志」） -->
        <div v-if="chatting" class="mb-3 flex items-center gap-2 text-xs text-toned">
          <span class="inline-block w-1.5 h-1.5 rounded-full bg-inverted animate-pulse" />
          <span class="font-mono">{{ chatVerb }}… {{ chatElapsed }}s</span>
        </div>
      </div>

      <!-- 输入条（固定钉在最底） -->
      <div class="shrink-0 border-t border-default pt-3 mt-1">
        <!-- 允许危险命令（默认拦 git push / gh pr create；开了才放行，同 feature/global）-->
        <label class="flex items-center gap-2 text-[11px] cursor-pointer mb-2">
          <input v-model="allowDanger" type="checkbox" class="accent-error" />
          <span :class="allowDanger ? 'text-error' : 'text-dimmed'">{{ allowDanger ? $t('global.dangerOn') : $t('global.dangerOff') }}</span>
        </label>
        <textarea
          v-model="chatInput" rows="3" :placeholder="$t('fix.chatPlaceholder')" :disabled="chatting"
          class="w-full text-sm bg-muted border border-default rounded px-2 py-1.5 resize-y outline-none focus:border-accented disabled:opacity-50"
        />
        <div class="mt-2 flex items-center gap-3">
          <!-- ultracode 后台激活：未激活=灰渐变，激活=紫渐变+扫光；点一次永久记住 -->
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

      <!-- worktree 工具（固定在最底） -->
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
/* ultracode 按钮：激活态才有高光扫过；未激活是灰的、不扫光。*/
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

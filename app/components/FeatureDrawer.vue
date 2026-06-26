<script setup lang="ts">
// Feature 任务抽屉:对话 + 方案卡 + 决策 checklist + 批准 + 实现进度 + 开 PR + 交接。
const props = defineProps<{ featureId: string | null }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ changed: [] }>()
const { t, locale } = useI18n()
const toast = useToast()

type DecisionPoint = { id: string; question: string; options: { label: string; tradeoff: string }[]; recommendation: string; defaultChoice: string; blocking: boolean }
type Plan = {
  requirementRestated: string; assumptions: string[]; affectedAreas: string[]; approach: string
  decisionPoints: DecisionPoint[]; plannedSteps: string[]; outOfScope: string[]; scopeWarning: string
  testPlan: string; prTitle: string; prBody: string
}
type Turn = { id: string; role: 'user' | 'assistant'; content: string; status: string }
type Task = { id: string; title: string | null; description?: string; status: string; branch: string | null; prUrl: string | null; prNumber: number | null; error: string | null }
type Detail = { task: Task; turns: Turn[]; events?: { ts: string; kind: string; message: string | null }[]; plan: Plan | null; busy: boolean }

const data = ref<Detail | null>(null)
const view = ref<'main' | 'pr'>('main')
const input = ref('')
const liveAssistant = ref('')
const logLines = ref<string[]>([])
const showLog = ref(false)
const confirming = ref('') // '' | 'discard'（抽屉内联确认，不用弹窗）
const busy = ref(false)
const decisions = reactive<Record<string, string>>({})
let es: EventSource | null = null

const task = computed(() => data.value?.task)
const plan = computed(() => data.value?.plan)
const status = computed(() => task.value?.status || '')
const running = computed(() => {
  const ts = data.value?.turns ?? []
  return data.value?.busy || (ts.length > 0 && ts[ts.length - 1]!.role === 'assistant' && ts[ts.length - 1]!.status === 'streaming')
})
const canChat = computed(() => !running.value && !busy.value)

function notify(msg: string, ok = false) { toast.add({ title: msg, color: ok ? 'success' : 'error', icon: ok ? 'i-lucide-check' : 'i-lucide-triangle-alert' }) }
function hhmmss(iso?: string) { return new Date(iso ?? new Date().toISOString()).toLocaleTimeString(locale.value, { hour12: false }) }

async function load() {
  if (!props.featureId) return
  data.value = await $fetch<Detail>(`/api/features/${props.featureId}`)
  // 首次：用落库的历史事件回填运行日志（同 fix）
  if (!logLines.value.length && data.value.events?.length) {
    logLines.value = data.value.events.filter((e) => e.message).map((e) => `${hhmmss(e.ts)}  ${e.message}`)
  }
  // 初始化决策选择(默认值 / 推荐 / 第一项)
  for (const dp of plan.value?.decisionPoints ?? []) {
    if (!decisions[dp.id]) decisions[dp.id] = dp.defaultChoice || dp.recommendation || dp.options[0]?.label || ''
  }
  emit('changed')
}
async function doDelete() {
  busy.value = true
  try { await $fetch(`/api/features/${props.featureId}`, { method: 'DELETE' }); emit('changed'); open.value = false }
  catch (e: any) { notify(e?.data?.statusMessage || t('common.failed')) }
  finally { busy.value = false; confirming.value = '' }
}
function openSSE() {
  if (!props.featureId || !import.meta.client) return
  es?.close()
  es = new EventSource(`/api/features/${props.featureId}/stream`)
  es.onmessage = (ev) => {
    try {
      const e = JSON.parse(ev.data)
      if (e.kind === 'text') { liveAssistant.value += e.message || ''; return }
      if (e.message) { logLines.value.push(`${hhmmss()}  ${e.message}`); if (logLines.value.length > 300) logLines.value.shift() }
      if (['done', 'error', 'chat'].includes(e.kind)) { liveAssistant.value = ''; load() }
    } catch { /* ignore */ }
  }
}
function closeSSE() { es?.close(); es = null }

watch([open, () => props.featureId], ([o]) => {
  if (o && props.featureId) { view.value = 'main'; logLines.value = []; showLog.value = false; confirming.value = ''; for (const k in decisions) delete decisions[k]; load(); openSSE() }
  else closeSSE()
})
onBeforeUnmount(closeSSE)

// 进行中轮询兜底
let pollTimer: ReturnType<typeof setInterval> | null = null
watch([running, open], ([r, o]) => {
  if (r && o && !pollTimer) pollTimer = setInterval(load, 2500)
  else if ((!r || !o) && pollTimer) { clearInterval(pollTimer); pollTimer = null }
})
onBeforeUnmount(() => { if (pollTimer) clearInterval(pollTimer) })

const scrollEl = ref<HTMLElement | null>(null)
watch([() => data.value?.turns.length, liveAssistant], () => { nextTick(() => { const el = scrollEl.value; if (el) el.scrollTop = el.scrollHeight }) })

async function sendChat() {
  const msg = input.value.trim()
  if (!msg || !canChat.value) return
  input.value = ''; liveAssistant.value = ''
  try { await $fetch(`/api/features/${props.featureId}/chat`, { method: 'POST', body: { message: msg } }); await load() }
  catch (e: any) { input.value = msg; notify(e?.data?.statusMessage || t('common.failed')) }
}
async function stop() {
  try { await $fetch(`/api/features/${props.featureId}/stop`, { method: 'POST' }); await load() }
  catch { /* ignore */ }
}
async function approve() {
  // blocking 决策必须选
  for (const dp of plan.value?.decisionPoints ?? []) if (dp.blocking && !decisions[dp.id]) { notify(t('feature.pickBlocking')); return }
  busy.value = true
  try { await $fetch(`/api/features/${props.featureId}/approve`, { method: 'POST', body: { decisions: { ...decisions } } }); await load() }
  catch (e: any) { notify(e?.data?.statusMessage || t('common.failed')) }
  finally { busy.value = false }
}

// 开 PR:预览 → 确认
const pr = ref<{ title: string; body: string; diff: string; filesChanged: number; additions: number; deletions: number; base: string; branch: string } | null>(null)
async function openPrPreview() {
  busy.value = true
  try {
    pr.value = await $fetch(`/api/features/${props.featureId}/open-pr`, { method: 'POST', body: { dryRun: true } })
    view.value = 'pr'
  } catch (e: any) { notify(e?.data?.statusMessage || t('common.failed')) }
  finally { busy.value = false }
}
async function confirmPr() {
  if (!pr.value) return
  busy.value = true
  try {
    const res = await $fetch<{ url: string; number: number }>(`/api/features/${props.featureId}/open-pr`, { method: 'POST', body: { dryRun: false, title: pr.value.title, body: pr.value.body } })
    notify(t('feature.prOpened', { n: res.number || '' }), true)
    view.value = 'main'; await load()
  } catch (e: any) { notify(e?.data?.statusMessage || t('common.failed')) }
  finally { busy.value = false }
}
</script>

<template>
  <USlideover v-model:open="open" :title="$t('feature.tab')" :ui="{ content: 'w-[calc(100vw-15rem)] max-w-none min-w-[640px]' }">
    <template #body>
      <div v-if="!task" class="text-xs text-dimmed p-4">{{ $t('common.loading') }}</div>

      <!-- 开 PR 预览 -->
      <div v-else-if="view === 'pr'" class="flex flex-col h-full min-h-0">
        <div class="shrink-0 flex items-center gap-2 mb-2 text-sm">
          <button class="text-dimmed hover:text-highlighted" @click="view = 'main'">← {{ $t('feature.back') }}</button>
          <span class="ml-auto text-xs text-dimmed font-mono">{{ pr?.branch }} → {{ pr?.base }}</span>
        </div>
        <label class="block text-xs text-dimmed">{{ $t('feature.prTitle') }}
          <input v-model="pr!.title" class="w-full text-sm border-b border-default focus:border-inverted outline-none py-1 mt-1" />
        </label>
        <label class="block text-xs text-dimmed mt-3">{{ $t('feature.prBody') }}
          <textarea v-model="pr!.body" rows="5" class="w-full text-sm border border-default rounded px-2 py-1 mt-1 resize-y outline-none focus:border-inverted" />
        </label>
        <div class="text-xs text-dimmed mt-3 mb-1">{{ $t('feature.diff') }} · {{ pr?.filesChanged }} files +{{ pr?.additions }} −{{ pr?.deletions }}</div>
        <pre class="flex-1 min-h-0 overflow-auto bg-neutral-900 text-neutral-300 rounded p-2 text-[11px] leading-relaxed whitespace-pre-wrap">{{ pr?.diff }}</pre>
        <div class="shrink-0 mt-3">
          <button class="text-sm bg-inverted text-inverted px-5 py-2 rounded hover:bg-inverted/90 disabled:opacity-40" :disabled="busy || !pr?.title.trim()" @click="confirmPr">{{ busy ? $t('common.loading') : $t('feature.confirmOpenPr') }}</button>
        </div>
      </div>

      <!-- 主视图 -->
      <div v-else class="flex flex-col h-full min-h-0">
        <!-- header -->
        <div class="shrink-0 flex items-center gap-2 pb-2 mb-2 border-b border-default">
          <span class="text-sm font-medium truncate min-w-0">{{ task.title || task.description || $t('feature.untitled') }}</span>
          <span class="shrink-0 text-[10px] uppercase tracking-wider px-2 py-0.5 border rounded-full" :class="status === 'opened' ? 'text-success border-success/40' : status === 'error' ? 'text-error border-error/40' : 'text-toned border-accented'">{{ $t('feature.status.' + status) }}</span>
          <a v-if="task.prUrl" :href="task.prUrl" target="_blank" class="text-xs text-muted hover:text-highlighted shrink-0">PR #{{ task.prNumber }} ↗</a>
          <!-- 删除：抽屉内联确认（不用弹窗，避免 drawer 上 dialog 无法交互）-->
          <template v-if="confirming === 'discard'">
            <span class="ml-auto text-xs text-dimmed">{{ $t('feature.discardConfirm') }}</span>
            <button class="text-xs text-error font-medium hover:underline disabled:opacity-40" :disabled="busy" @click="doDelete">{{ $t('common.delete') }}</button>
            <button class="text-xs text-dimmed hover:text-highlighted" @click="confirming = ''">{{ $t('common.cancel') }}</button>
          </template>
          <button v-else class="ml-auto text-xs text-dimmed hover:text-highlighted disabled:opacity-40 shrink-0" :disabled="running || busy" @click="confirming = 'discard'">{{ $t('feature.discard') }}</button>
        </div>

        <!-- 运行日志（思考/分析过程，可展开；同 fix）-->
        <div v-if="logLines.length" class="shrink-0 text-[11px] text-dimmed mb-2">
          <button class="hover:text-highlighted" @click="showLog = !showLog">{{ showLog ? $t('review.collapseLog') : $t('review.expandLog', { count: logLines.length }) }}</button>
          <pre v-if="showLog" class="mt-1 max-h-48 overflow-auto bg-neutral-900 text-neutral-300 rounded p-2 leading-relaxed font-mono whitespace-pre-wrap">{{ logLines.join('\n') }}</pre>
        </div>

        <!-- PR 已开:交接提示 -->
        <div v-if="status === 'opened'" class="shrink-0 mb-3 text-xs rounded border border-success/30 bg-success/5 p-3 leading-relaxed">
          ✅ {{ $t('feature.handoff') }}
          <a v-if="task.prUrl" :href="task.prUrl" target="_blank" class="block mt-1 text-highlighted hover:underline">{{ $t('feature.gotoReview') }} →</a>
        </div>

        <!-- 滚动区:对话 + 方案 + 决策 -->
        <div ref="scrollEl" class="flex-1 min-h-0 overflow-y-auto space-y-4 pr-1">
          <!-- 对话轮 -->
          <div v-for="(turn, ti) in data?.turns ?? []" :key="turn.id" :class="turn.role === 'user' ? 'text-right' : ''">
            <div class="inline-block max-w-[92%] text-left text-sm rounded-lg px-3 py-2 whitespace-pre-wrap break-words" :class="turn.role === 'user' ? 'bg-inverted text-inverted' : 'bg-muted'">{{ turn.status === 'streaming' && ti === (data?.turns.length ?? 0) - 1 && liveAssistant ? liveAssistant : turn.content }}<span v-if="turn.status === 'streaming'" class="animate-pulse">▍</span></div>
          </div>
          <div v-if="running" class="text-xs text-toned flex items-center gap-2"><span class="inline-block w-1.5 h-1.5 rounded-full bg-inverted animate-pulse" />{{ status === 'building' ? $t('feature.status.building') : $t('feature.status.analyzing') }}…</div>

          <!-- 方案卡(planned/built/opened 都显示) -->
          <div v-if="plan && status !== 'analyzing'" class="rounded border border-default p-3 text-sm space-y-2">
            <div class="text-[10px] uppercase tracking-[0.15em] text-dimmed">{{ $t('feature.planTitle') }}</div>
            <p v-if="plan.scopeWarning" class="text-xs text-warning">⚠️ {{ plan.scopeWarning }}</p>
            <div v-if="plan.approach"><span class="text-dimmed text-xs">{{ $t('feature.approach') }}：</span>{{ plan.approach }}</div>
            <ol v-if="plan.plannedSteps.length" class="list-decimal list-inside text-xs text-toned space-y-0.5">
              <li v-for="(s, i) in plan.plannedSteps" :key="i">{{ s }}</li>
            </ol>
            <details v-if="plan.testPlan || plan.outOfScope.length" class="text-xs text-dimmed">
              <summary class="cursor-pointer">{{ $t('feature.more') }}</summary>
              <p v-if="plan.testPlan" class="mt-1 whitespace-pre-wrap"><b>{{ $t('feature.testPlan') }}：</b>{{ plan.testPlan }}</p>
              <p v-if="plan.outOfScope.length" class="mt-1"><b>{{ $t('feature.outOfScope') }}：</b>{{ plan.outOfScope.join('；') }}</p>
            </details>
          </div>

          <!-- 决策 checklist(planned 时可改;待批准) -->
          <div v-if="plan?.decisionPoints.length && status === 'planned'" class="rounded border border-inverted p-3 space-y-3">
            <div class="text-[10px] uppercase tracking-[0.15em] text-dimmed">{{ $t('feature.decisions') }}</div>
            <div v-for="dp in plan.decisionPoints" :key="dp.id" class="text-sm">
              <div class="font-medium">{{ dp.question }} <span v-if="dp.blocking" class="text-[10px] text-error">*</span></div>
              <label v-for="o in dp.options" :key="o.label" class="flex items-start gap-2 mt-1 cursor-pointer">
                <input type="radio" class="mt-1 accent-neutral-900 dark:accent-neutral-100" :name="dp.id" :value="o.label" v-model="decisions[dp.id]" />
                <span class="text-xs"><span :class="decisions[dp.id] === o.label ? 'text-highlighted' : 'text-toned'">{{ o.label }}</span><span v-if="o.tradeoff" class="text-dimmed">（{{ o.tradeoff }}）</span><span v-if="dp.recommendation === o.label" class="ml-1 text-[10px] text-success">{{ $t('feature.recommended') }}</span></span>
              </label>
            </div>
          </div>

          <p v-if="status === 'error' && task.error" class="text-xs text-error">{{ task.error }}</p>
        </div>

        <!-- 动作区 + composer -->
        <div class="shrink-0 pt-3 mt-2 border-t border-default space-y-2">
          <div class="flex items-center gap-2">
            <button v-if="status === 'planned'" class="text-sm bg-inverted text-inverted px-4 py-1.5 rounded hover:bg-inverted/90 disabled:opacity-40" :disabled="busy || running" @click="approve">{{ busy ? $t('common.loading') : $t('feature.approve') }}</button>
            <button v-if="status === 'built'" class="text-sm bg-inverted text-inverted px-4 py-1.5 rounded hover:bg-inverted/90 disabled:opacity-40" :disabled="busy || running" @click="openPrPreview">{{ busy ? $t('common.loading') : $t('feature.openPr') }}</button>
            <button v-if="running" class="text-sm border border-accented px-4 py-1.5 rounded hover:bg-muted" @click="stop">{{ $t('fix.stop') }}</button>
          </div>
          <textarea
            v-model="input" rows="2" :placeholder="status === 'planned' ? $t('feature.refinePlaceholder') : $t('feature.chatPlaceholder')"
            class="w-full text-sm border border-default rounded px-2 py-1.5 resize-y outline-none focus:border-inverted" :disabled="!canChat"
          />
          <div class="flex justify-end">
            <button class="w-24 text-sm bg-inverted text-inverted py-1.5 rounded hover:bg-inverted/90 disabled:opacity-40" :disabled="!input.trim() || !canChat" @click="sendChat">{{ $t('global.send') }}</button>
          </div>
        </div>
      </div>
    </template>
  </USlideover>
</template>

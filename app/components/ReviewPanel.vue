<script setup lang="ts">
const props = defineProps<{ projectId: string; prNumber: number; reviewId: string | null }>()
const emit = defineEmits<{ created: [id: string]; changed: [] }>()
const { t, locale } = useI18n()

type Finding = {
  id: string; fid: string; severity: 'High' | 'Medium' | 'Low'; title: string
  location: string | null; problem: string | null; detail: string | null; fix: string | null
  introducedByPr: boolean; checked: boolean; notes: string | null
  rechecks: { round: number; status: string; text: string | null; at: string }[]
}
type ReviewData = {
  review: any
  findings: Finding[]
  posts: { round: number; url: string; mode: string; at: string }[]
  events: { ts: string; kind: string; message: string | null }[]
}

const rid = ref<string | null>(props.reviewId)
watch(() => props.reviewId, (v) => { rid.value = v; if (v) load() })

const data = ref<ReviewData | null>(null)
const live = ref('')
const logLines = ref<string[]>([])
const showLog = ref(false)
const logBox = ref<HTMLElement>()
watch(logLines, () => {
  if (showLog.value) nextTick(() => { if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight })
}, { deep: true })
const busy = ref('')
const preview = ref<any>(null) // 发评论的 dry-run 预览（提前定义：卸载守卫 / 切 PR 清理要用）
let es: EventSource | null = null
let alive = true // 组件卸载后忽略 in-flight $fetch 的回写（生成预览时关 drawer，请求还在跑）

async function load() {
  if (!rid.value) return
  const d = await $fetch<ReviewData>(`/api/reviews/${rid.value}`)
  if (!alive) return
  data.value = d
  emit('changed') // 通知页面：这条 review 状态/内容可能变了 → 刷新任务列表
  // 用历史事件回填日志（这样打开已完成的任务也能看到 agent 当时一行行干了什么）
  if (!logLines.value.length && data.value.events?.length) {
    logLines.value = data.value.events
      .filter((e) => e.message)
      .map((e) => `${new Date(e.ts).toLocaleTimeString(locale.value, { hour12: false })}  ${e.message}`)
  }
}
function openSSE() {
  if (!rid.value || !import.meta.client) return
  es?.close()
  es = new EventSource(`/api/reviews/${rid.value}/stream`)
  es.onmessage = (ev) => {
    try {
      const e = JSON.parse(ev.data)
      if (e.message) {
        live.value = e.message
        // 滚动日志：像终端一行行
        logLines.value.push(`${new Date().toLocaleTimeString(locale.value, { hour12: false })}  ${e.message}`)
        if (logLines.value.length > 200) logLines.value.shift()
      }
      if (['done', 'recheck', 'posted', 'error', 'status'].includes(e.kind)) load()
    } catch {}
  }
}
watch(rid, (v) => { if (v) { load(); openSSE() } }, { immediate: true })
onBeforeUnmount(() => { alive = false; es?.close() })

// 审核状态文案：存 i18n 键，缺失回退原始 status 码
const STATUS: Record<string, string> = {
  queued: 'review.status.queued', cloning: 'review.status.cloning', reviewing: 'review.status.reviewing', draft: 'review.status.draft',
  ready_to_post: 'review.status.ready_to_post', posted: 'review.status.posted', recheck_requested: 'review.status.recheck_requested', rechecking: 'review.status.rechecking', error: 'review.status.error',
}
function statusLabel(s: string) { const k = STATUS[s]; return k ? t(k) : s }
const running = computed(() => ['queued', 'cloning', 'reviewing', 'recheck_requested', 'rechecking'].includes(data.value?.review?.status))

async function startReview() {
  busy.value = 'start'
  try {
    const res = await $fetch<{ created: { id: string }[] }>('/api/reviews', {
      method: 'POST', body: { projectId: props.projectId, pulls: [{ number: props.prNumber }] },
    })
    const id = res.created[0]?.id
    if (id) { rid.value = id; emit('created', id) }
  } finally { busy.value = '' }
}
// 抽屉里弹模态会被 USlideover 的焦点陷阱挡住、点不动 → 改成就地两步确认，且不关抽屉，能边跑边看日志
const confirming = ref<'' | 'rerun' | 'recheck' | 'fresh'>('')
// fresh=true → audit complet à zéro (efface findings/notes, revue non guidée) ;
// false → re-revue guidée qui conserve findings + notes.
async function rerun(fresh = false) {
  confirming.value = ''
  busy.value = 'run'; logLines.value = []; showLog.value = true
  try { await $fetch(`/api/reviews/${rid.value}/run`, { method: 'POST', body: { fresh } }); await load() }
  catch (e: any) { live.value = e?.data?.statusMessage || t('review.triggerFailed') }
  finally { busy.value = '' }
}
async function recheck() {
  confirming.value = ''
  busy.value = 'recheck'; logLines.value = []; showLog.value = true
  try { await $fetch(`/api/reviews/${rid.value}/recheck`, { method: 'POST' }); await load() }
  catch (e: any) { live.value = e?.data?.statusMessage || t('review.triggerFailed') }
  finally { busy.value = '' }
}

// findings 编辑
const saving = ref<Record<string, any>>({})
async function toggleFinding(f: Finding) {
  f.checked = !f.checked
  await $fetch(`/api/findings/${f.id}`, { method: 'PATCH', body: { checked: f.checked } })
}
function saveNotes(f: Finding) {
  clearTimeout(saving.value[f.id])
  saving.value[f.id] = setTimeout(() => {
    $fetch(`/api/findings/${f.id}`, { method: 'PATCH', body: { notes: f.notes || '' } })
  }, 600)
}
const gnTimer = ref<any>(null)
function saveGlobalNotes() {
  clearTimeout(gnTimer.value)
  gnTimer.value = setTimeout(() => {
    $fetch(`/api/reviews/${rid.value}`, { method: 'PATCH', body: { globalNotes: data.value?.review.globalNotes || '' } })
  }, 600)
}
const riTimer = ref<any>(null)
function saveInstruction() {
  clearTimeout(riTimer.value)
  riTimer.value = setTimeout(() => {
    $fetch(`/api/reviews/${rid.value}`, { method: 'PATCH', body: { reviewInstruction: data.value?.review.reviewInstruction || '' } })
  }, 600)
}

// 发评论：先 dry-run 预览，再确认发布。卸载后（drawer 关了）忽略回写，别串到下一个 PR。
async function doPreview(force = false) {
  busy.value = 'preview'
  try {
    const res = await $fetch<{ assembled: any }>(`/api/reviews/${rid.value}/post`, { method: 'POST', body: { dryRun: true, force } })
    if (alive) preview.value = res.assembled
  } catch (e: any) { if (alive) live.value = e?.data?.statusMessage || t('review.previewFailed') }
  finally { busy.value = '' }
}
async function confirmPost() {
  busy.value = 'post'
  try {
    const res = await $fetch<{ url: string }>(`/api/reviews/${rid.value}/post`, { method: 'POST', body: { dryRun: false } })
    if (!alive) return
    preview.value = null; live.value = t('review.published', { url: res.url }); await load()
  } catch (e: any) { if (alive) live.value = e?.data?.statusMessage || t('review.publishFailed') }
  finally { busy.value = '' }
}

// AI 常把需求/测试路径写成一大段没换行的流水 → 在枚举/分节标签前补换行，便于阅读
function fmt(t?: string | null) {
  if (!t) return ''
  return t
    // 圆圈数字前换行
    .replace(/([^\n])\s*([①②③④⑤⑥⑦⑧⑨⑩⑪⑫])/g, '$1\n$2')
    // a) b) 之类字母枚举前换行 + 缩进（负向 lookbehind 防止误伤词中字母）
    .replace(/([^A-Za-z\n])\s*([a-h][)）])\s*/g, '$1\n　$2 ')
    // 已知分节标签前空一行
    .replace(/\s*(用户视角[^：:]*|正向\s*case|负向\s*\/?\s*边界|负向|边界|回归点|受影响的人|改动前|改动后)([：:])/g, '\n\n$1$2')
    .replace(/^\n+/, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const checkedCount = computed(() => data.value?.findings.filter((f) => f.checked).length ?? 0)
const sevCls: Record<string, string> = { High: 'text-highlighted font-medium', Medium: 'text-toned', Low: 'text-dimmed' }
const RC: Record<string, string> = {
  fixed: 'review.rc.fixed', partial: 'review.rc.partial', unaddressed: 'review.rc.unaddressed', replied: 'review.rc.replied', new: 'review.rc.new',
  kept: 'review.rc.kept', retracted: 'review.rc.retracted', adjusted: 'review.rc.adjusted', discuss: 'review.rc.discuss',
}
function rcLabel(s: string) { const k = RC[s]; return k ? t(k) : s }
// 发评论时按复审状态被跳过的原因（预览里告知）
const SKIP_REASON: Record<string, string> = {
  'replied-no-note': 'review.skipReason.repliedNoNote',
  retracted: 'review.skipReason.retracted',
}
function skipReasonLabel(s: string) { const k = SKIP_REASON[s]; return k ? t(k) : s }
</script>

<template>
  <div class="flex-1 overflow-y-auto px-6 py-5">
    <!-- 没任务 -->
    <div v-if="!rid" class="text-center py-16">
      <p class="text-sm text-dimmed mb-4">{{ $t('review.noTask') }}</p>
      <button class="text-sm bg-inverted text-inverted px-5 py-2 hover:bg-inverted/90 disabled:opacity-40" :disabled="busy === 'start'" @click="startReview">
        {{ busy === 'start' ? $t('review.creatingTask') : $t('review.startReview') }}
      </button>
    </div>

    <template v-else-if="data">
      <!-- 状态 + 操作 -->
      <div class="flex items-center justify-between gap-3 mb-1">
        <div class="text-sm">
          <span class="text-dimmed">{{ $t('review.statusLabel') }}</span>
          <span class="ml-2" :class="data.review.status === 'error' ? 'text-highlighted font-medium' : 'text-highlighted'">{{ statusLabel(data.review.status) }}</span>
          <span v-if="data.review.authorUpdated" class="ml-2 text-xs text-highlighted font-medium" :title="$t('review.authorUpdatedTitle')">● {{ $t('project.authorUpdated') }}</span>
        </div>
        <div class="flex items-center gap-3 text-xs">
          <template v-if="confirming === 'rerun'">
            <span class="text-dimmed">{{ $t('review.rerunConfirm') }}</span>
            <button class="text-highlighted font-medium hover:underline disabled:opacity-40" :disabled="!!busy" @click="rerun()">{{ $t('review.startRerun') }}</button>
            <button class="text-dimmed hover:text-highlighted" @click="confirming = ''">{{ $t('common.cancel') }}</button>
          </template>
          <template v-else-if="confirming === 'recheck'">
            <span class="text-dimmed">{{ $t('review.recheckConfirm') }}</span>
            <button class="text-highlighted font-medium hover:underline disabled:opacity-40" :disabled="!!busy" @click="recheck">{{ $t('review.startRecheck') }}</button>
            <button class="text-dimmed hover:text-highlighted" @click="confirming = ''">{{ $t('common.cancel') }}</button>
          </template>
          <template v-else-if="confirming === 'fresh'">
            <span class="text-dimmed">{{ $t('review.freshConfirm') }}</span>
            <button class="text-highlighted font-medium hover:underline disabled:opacity-40" :disabled="!!busy" @click="rerun(true)">{{ $t('review.startFresh') }}</button>
            <button class="text-dimmed hover:text-highlighted" @click="confirming = ''">{{ $t('common.cancel') }}</button>
          </template>
          <template v-else>
            <!-- Relance une revue complète à zéro (efface findings + notes) → confirmation in-place. Dispo en error/draft. -->
            <button v-if="data.review.status === 'error' || data.review.status === 'draft'" class="bg-inverted text-inverted px-3 py-1 hover:bg-inverted/90 disabled:opacity-40" :disabled="running || !!busy" :title="$t('review.retryTitle')" @click="confirming = 'fresh'">{{ $t('review.retryBtn') }}</button>
            <button class="text-muted hover:text-highlighted disabled:opacity-40" :disabled="running || !!busy" :title="$t('review.rerunTitle')" @click="confirming = 'rerun'">{{ $t('review.rerunBtn') }}</button>
            <button class="hover:text-highlighted disabled:opacity-40" :class="data.review.authorUpdated ? 'text-highlighted font-medium' : 'text-muted'" :disabled="running || !!busy" :title="$t('review.recheckTitle')" @click="confirming = 'recheck'">{{ $t('review.recheckBtn') }}</button>
          </template>
        </div>
      </div>
      <div v-if="running || live || logLines.length" class="text-xs text-dimmed mb-2">
        <div class="flex items-center gap-2">
          <span class="min-w-0 truncate flex-1">
            <span v-if="running" class="inline-block w-1.5 h-1.5 rounded-full bg-inverted animate-pulse mr-1.5" />{{ running ? (live || $t('review.processing')) : $t('review.runLog', { count: logLines.length }) }}
          </span>
          <button v-if="logLines.length" class="text-dimmed hover:text-highlighted shrink-0" @click="showLog = !showLog">
            {{ showLog ? $t('review.collapseLog') : $t('review.expandLog', { count: logLines.length }) }}
          </button>
        </div>
        <!-- 滚动日志：agent 一行行的动作（读文件 / grep / git diff …）-->
        <pre v-if="showLog && logLines.length" ref="logBox" class="mt-2 max-h-56 overflow-auto bg-neutral-900 text-neutral-300 rounded p-2 text-[11px] leading-relaxed font-mono whitespace-pre-wrap">{{ logLines.join('\n') }}</pre>
      </div>
      <p v-if="data.review.error" class="text-xs text-highlighted border border-default rounded p-2 mb-4 whitespace-pre-wrap">{{ data.review.error }}</p>

      <!-- AI 总评（置顶） -->
      <section v-if="data.review.conclusion" class="mb-5 border border-default rounded p-3">
        <div class="text-[10px] uppercase tracking-[0.15em] text-dimmed mb-1">{{ $t('review.aiSummary') }}</div>
        <p class="text-sm text-default whitespace-pre-wrap leading-relaxed">{{ fmt(data.review.conclusion) }}</p>
      </section>

      <!-- 给 AI 的审核指令（“按我反馈复审”时参考） -->
      <section class="mb-6">
        <div class="text-[10px] uppercase tracking-[0.15em] text-dimmed mb-1">{{ $t('review.instructionLabel') }}</div>
        <textarea
          v-model="data.review.reviewInstruction" rows="2"
          :placeholder="$t('review.instructionPlaceholder')"
          class="w-full text-sm bg-muted border border-default rounded px-2 py-1 resize-y outline-none focus:border-accented"
          @input="saveInstruction"
        />
      </section>

      <!-- 需求 / 测试路径 -->
      <template v-if="data.review.requirement || data.review.testPath">
        <section v-if="data.review.requirement" class="mb-4">
          <div class="text-[10px] uppercase tracking-[0.15em] text-dimmed mb-1">{{ $t('review.requirement') }}</div>
          <p class="text-sm text-default whitespace-pre-wrap leading-relaxed">{{ fmt(data.review.requirement) }}</p>
        </section>
        <section v-if="data.review.testPath" class="mb-5">
          <div class="text-[10px] uppercase tracking-[0.15em] text-dimmed mb-1">{{ $t('review.testPath') }}</div>
          <p class="text-sm text-default whitespace-pre-wrap leading-relaxed">{{ fmt(data.review.testPath) }}</p>
        </section>
      </template>

      <!-- findings -->
      <div class="text-[10px] uppercase tracking-[0.15em] text-dimmed mb-2">{{ $t('review.findings', { count: data.findings.length }) }}</div>
      <div v-for="f in data.findings" :key="f.id" class="border-t border-default py-3">
        <div class="flex gap-3 items-start">
          <input type="checkbox" class="accent-neutral-900 dark:accent-neutral-100 mt-1" :checked="f.checked" @change="toggleFinding(f)" />
          <div class="min-w-0 flex-1">
            <div class="text-sm">
              <span class="text-xs mr-1" :class="sevCls[f.severity]">[{{ f.severity }}]</span>{{ f.title }}
            </div>
            <div class="text-xs text-dimmed mt-0.5">{{ f.location }}<span v-if="!f.introducedByPr"> {{ $t('review.preExisting') }}</span></div>
            <p v-if="f.problem" class="text-sm text-toned mt-1">{{ f.problem }}</p>
            <details v-if="f.detail || f.fix" class="mt-1">
              <summary class="text-xs text-dimmed cursor-pointer">{{ $t('review.detailFix') }}</summary>
              <pre v-if="f.detail" class="text-xs text-toned whitespace-pre-wrap mt-1 font-sans">{{ f.detail }}</pre>
              <pre v-if="f.fix" class="text-xs bg-muted border border-default rounded p-2 whitespace-pre-wrap mt-1 overflow-x-auto">{{ f.fix }}</pre>
            </details>
            <div v-for="r in f.rechecks" :key="r.round" class="text-xs mt-2 border-l-2 border-default pl-2">
              <span class="font-medium">🔁 {{ $t('review.recheckRound', { round: r.round }) }} · {{ rcLabel(r.status) }}</span>
              <span class="text-muted"> {{ r.text }}</span>
            </div>
            <textarea
              v-model="f.notes" rows="1" :placeholder="$t('review.notePlaceholder')"
              class="w-full text-xs bg-muted border border-default rounded px-2 py-1 mt-2 resize-y outline-none focus:border-accented"
              @input="saveNotes(f)"
            />
          </div>
        </div>
      </div>
      <p v-if="!data.findings.length && !running" class="text-sm text-dimmed py-4">{{ $t('review.noFindings') }}</p>

      <!-- 整体注释 + 发布 -->
      <section v-if="data.findings.length" class="mt-5 border-t border-default pt-4">
        <div class="text-[10px] uppercase tracking-[0.15em] text-dimmed mb-1">{{ $t('review.globalNotesLabel') }}</div>
        <textarea
          v-model="data.review.globalNotes" rows="2" :placeholder="$t('review.globalNotesPlaceholder')"
          class="w-full text-sm bg-muted border border-default rounded px-2 py-1 resize-y outline-none focus:border-accented"
          @input="saveGlobalNotes"
        />
        <div class="flex items-center gap-3 mt-3">
          <button class="text-sm border border-accented px-4 py-1.5 hover:bg-muted disabled:opacity-40" :disabled="!checkedCount || !!busy" @click="doPreview()">
            <span v-if="busy === 'preview'" class="inline-flex items-center gap-1.5"><span class="inline-block w-1.5 h-1.5 rounded-full bg-inverted animate-pulse" />{{ $t('review.generatingPreview') }}</span>
            <span v-else>{{ $t('review.previewComment', { count: checkedCount }) }}</span>
          </button>
          <div v-if="data.posts.length" class="text-xs text-dimmed">
            {{ $t('review.postedTimes', { count: data.posts.length }) }} <a :href="data.posts[data.posts.length - 1]?.url" target="_blank" class="hover:text-highlighted underline">{{ $t('review.latest') }}</a>
          </div>
        </div>

        <!-- dry-run 预览 -->
        <div v-if="preview" class="mt-3 border border-default rounded p-3">
          <div class="flex items-center justify-between mb-2">
            <span class="text-xs text-dimmed">{{ $t('review.previewMeta', { count: preview.comments.length, mode: preview.mode }) }}<span v-if="preview.skipped?.length"> · {{ $t('review.previewSkipped', { count: preview.skipped.length }) }}</span></span>
            <div class="flex gap-3 items-center">
              <button class="text-xs text-dimmed hover:text-highlighted disabled:opacity-40" :disabled="!!busy" :title="$t('review.regenTitle')" @click="doPreview(true)">
                {{ busy === 'preview' ? $t('review.regenerating') : $t('review.regenerate') }}
              </button>
              <button class="text-xs text-dimmed hover:text-highlighted" @click="preview = null">{{ $t('review.close') }}</button>
              <button class="text-xs bg-inverted text-inverted px-3 py-1 hover:bg-inverted/90 disabled:opacity-40" :disabled="busy === 'post'" @click="confirmPost">
                {{ busy === 'post' ? $t('review.publishing') : $t('review.confirmPublish') }}
              </button>
            </div>
          </div>
          <div v-if="preview.skipped?.length" class="text-xs mb-2 border border-default rounded p-2 bg-muted">
            <div class="text-dimmed mb-1">{{ $t('review.skippedTitle', { count: preview.skipped.length }) }}</div>
            <div v-for="s in preview.skipped" :key="s.fid" class="text-toned">· {{ s.fid }} {{ s.title }} <span class="text-dimmed">— {{ skipReasonLabel(s.reason) }}</span></div>
          </div>
          <pre class="text-xs text-toned whitespace-pre-wrap font-sans max-h-60 overflow-y-auto">{{ preview.body }}</pre>
          <div v-for="(c, i) in preview.comments" :key="i" class="text-xs mt-2 border-t border-default pt-2">
            <span class="font-mono text-dimmed">{{ c.path }}:{{ c.line }}</span>
            <pre class="text-toned whitespace-pre-wrap font-sans mt-1">{{ c.body }}</pre>
          </div>
        </div>
      </section>
    </template>

    <p v-else class="text-sm text-dimmed py-8">{{ $t('common.loading') }}</p>
  </div>
</template>

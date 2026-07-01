<script setup lang="ts">
const props = defineProps<{
  projectId: string; prNumber: number | null; reviewId: string | null; fixId: string | null; initialTab?: string
  autoReviewOn?: boolean; autoFixOn?: boolean; autoNote?: string | null; autoRound?: number; autoMaxRounds?: number
  autoCoolingUntil?: string | null
}>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ taskCreated: [] }>()
const { t, te, locale } = useI18n()

// 两个实例级自动化开关（自动审核 / 自动修复）。本地乐观状态：点了立刻动，不等 8s 轮询回来（顺滑）；
// 失败或下次轮询再用真实值校正。只有 switch 本身可点（模板里用 div 而非 label，文字不触发切换）。
const reviewOnLocal = ref(props.autoReviewOn ?? false)
const fixOnLocal = ref(props.autoFixOn ?? false)
watch(() => props.autoReviewOn, (v) => { reviewOnLocal.value = v ?? false })
watch(() => props.autoFixOn, (v) => { fixOnLocal.value = v ?? false })
async function toggleAuto(field: 'reviewOn' | 'fixOn', value: boolean) {
  if (props.prNumber == null) return
  if (field === 'reviewOn') reviewOnLocal.value = value
  else fixOnLocal.value = value
  try {
    await $fetch(`/api/projects/${props.projectId}/pulls/${props.prNumber}/automation`, { method: 'POST', body: { [field]: value } })
    emit('taskCreated') // 触发父级 refreshPulls，把有效状态/轮数刷新回来
  } catch {
    // 失败 → 回退本地乐观值
    if (field === 'reviewOn') reviewOnLocal.value = !value
    else fixOnLocal.value = !value
  }
}
// 引擎停手原因 → 一行提示（capped/converged/cant_fix/...）
const autoNoteText = computed(() => {
  if (!props.autoNote) return ''
  const k = `automation.note.${props.autoNote}`
  return te(k) ? t(k, { round: props.autoRound ?? 0, max: props.autoMaxRounds ?? 0 }) : ''
})
// 冷却中：还有几分钟才会开始自动跑（用户可在此窗口关掉开关）
const coolingMinLeft = computed(() => {
  if (!props.autoCoolingUntil) return 0
  const ms = Date.parse(props.autoCoolingUntil) - Date.now()
  return ms > 0 ? Math.ceil(ms / 60000) : 0
})

type Detail = {
  number: number; title: string; body: string; author: string; createdAt: string
  state: string; branch: string; additions: number; deletions: number; changedFiles: number
  url: string; files: { path: string; additions: number; deletions: number }[]
  commits: { oid: string; headline: string; date: string; author: string }[]
}
type Node = {
  kind: 'comment' | 'review' | 'commit' | 'event'
  actor: string; isBot: boolean; at: string
  body?: string; bodyHtml?: string; state?: string; sha?: string; message?: string; verb?: string; detail?: string
}

const detail = ref<Detail | null>(null)
const openingHtml = ref('')
const nodes = ref<Node[]>([])
const pending = ref(false)
const error = ref('')

const activeTab = ref<'review' | 'fix' | 'timeline' | 'changes' | 'workflow'>('timeline')
const diff = ref<string | null>(null)
const diffTruncated = ref(false)
const diffPending = ref(false)

// ── 自动化工作流时间线（引擎对这条 PR 做了什么）──
type WfEvent = { id: string; kind: string; ts: string; message: string | null }
const wfEvents = ref<WfEvent[]>([])
const wfPending = ref(false)
let wfTimer: ReturnType<typeof setInterval> | null = null
async function loadWf() {
  if (!props.prNumber) return
  wfPending.value = true
  try {
    const r = await $fetch<{ events: WfEvent[] }>(`/api/projects/${props.projectId}/pulls/${props.prNumber}/automation-events`)
    wfEvents.value = r.events
  } catch { /* 静默：下次轮询再拉 */ } finally {
    wfPending.value = false
  }
}
function stopWfPoll() { if (wfTimer) { clearInterval(wfTimer); wfTimer = null } }
// 在「自动化」tab 时每 5s 拉一次，工作流进展实时冒出来
watch([activeTab, open], ([tabNow, isOpen]) => {
  stopWfPoll()
  if (isOpen && tabNow === 'workflow') {
    loadWf()
    wfTimer = setInterval(() => { if (typeof document === 'undefined' || document.visibilityState !== 'hidden') loadWf() }, 5000)
  }
})
onBeforeUnmount(stopWfPoll)
// 自动化事件 i18n：kind → 文案（fix_started/capped 带 message 插值）
const WF_DOT: Record<string, string> = {
  review_created: 'bg-inverted', recheck: 'bg-inverted', posted: 'bg-accented',
  fix_started: 'bg-inverted', pushed: 'bg-accented',
  capped: 'bg-warning', converged: 'bg-success', cant_fix: 'bg-error', fix_error: 'bg-error', post_error: 'bg-error',
  push_error: 'bg-error', fix_unverified: 'bg-warning', cooldown: 'bg-accented',
}
function wfLabel(ev: WfEvent) {
  const k = `automation.event.${ev.kind}`
  if (!te(k)) return ev.message ? `${ev.kind} ${ev.message}` : ev.kind
  return t(k, { round: ev.message ?? '', info: ev.message ?? '' })
}

// ── markdown 渲染（客户端动态加载 marked + dompurify）──
let _render: ((s: string) => string) | null = null
async function getRenderer() {
  if (_render) return _render
  const [{ marked }, dp] = await Promise.all([import('marked'), import('dompurify')])
  marked.setOptions({ gfm: true, breaks: true })
  const DOMPurify = (dp as any).default
  // 渲染后把 GitHub 私有图片（user-attachments / githubusercontent）的 src 改走后端代理，
  // 否则浏览器直连这些 URL 会 404（需 GitHub 登录态）。
  const PROXY = /(<img[^>]+\bsrc=")(https:\/\/(?:github\.com\/user-attachments\/|[a-z0-9-]+\.githubusercontent\.com\/)[^"]+)(")/gi
  _render = (s: string) => {
    const html = DOMPurify.sanitize(marked.parse(s ?? '', { async: false }) as string)
    return html.replace(PROXY, (_m: string, pre: string, url: string, post: string) => `${pre}/api/img?u=${encodeURIComponent(url)}${post}`)
  }
  return _render
}

watch(
  () => [open.value, props.prNumber] as const,
  async ([isOpen, num]) => {
    if (!isOpen || !num) return
    if (detail.value?.number === num) return
    detail.value = null; nodes.value = []; openingHtml.value = ''; diff.value = null; wfEvents.value = []
    activeTab.value = (props.initialTab as any) || (props.reviewId ? 'review' : 'timeline'); error.value = ''; pending.value = true
    try {
      const res = await $fetch<{ detail: Detail; nodes: Node[] }>(
        `/api/projects/${props.projectId}/pulls/${num}/timeline`,
      )
      const render = await getRenderer()
      detail.value = res.detail
      openingHtml.value = render(res.detail.body)
      nodes.value = res.nodes.map((n) =>
        n.body ? { ...n, bodyHtml: render(n.body) } : n,
      )
    } catch (e: any) {
      error.value = e?.data?.statusMessage || e?.message || t('prDrawer.loadFailed')
    } finally {
      pending.value = false
    }
  },
  { immediate: true },
)

// 切到「改动」才拉 diff
watch(activeTab, async (nextTab) => {
  if (nextTab !== 'changes' || diff.value !== null || !props.prNumber) return
  diffPending.value = true
  try {
    const res = await $fetch<{ diff: string; truncated: boolean }>(
      `/api/projects/${props.projectId}/pulls/${props.prNumber}/diff`,
    )
    diff.value = res.diff
    diffTruncated.value = res.truncated
  } catch (e: any) {
    diff.value = ''
    error.value = e?.data?.statusMessage || e?.message || t('prDrawer.diffLoadFailed')
  } finally {
    diffPending.value = false
  }
})

// 相对时间（按当前语言本地化；超过 7 天回退到本地日期格式）
function rel(iso: string) {
  if (!iso) return ''
  const ts = new Date(iso).getTime()
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return t('prDrawer.time.justNow')
  if (s < 3600) return t('prDrawer.time.minutesAgo', { n: Math.floor(s / 60) })
  if (s < 86400) return t('prDrawer.time.hoursAgo', { n: Math.floor(s / 3600) })
  if (s < 86400 * 7) return t('prDrawer.time.daysAgo', { n: Math.floor(s / 86400) })
  return new Date(iso).toLocaleDateString(locale.value)
}

// review 状态 / 事件动词：存 i18n 键，模板里用 t() 解析（缺失则回退）
const REVIEW_STATE: Record<string, string> = {
  approved: 'prDrawer.review.approved', changes_requested: 'prDrawer.review.changesRequested',
  commented: 'prDrawer.review.commented', dismissed: 'prDrawer.review.dismissed',
}
const VERB: Record<string, string> = {
  labeled: 'prDrawer.verb.labeled', unlabeled: 'prDrawer.verb.unlabeled', renamed: 'prDrawer.verb.renamed', referenced: 'prDrawer.verb.referenced',
  head_ref_force_pushed: 'prDrawer.verb.head_ref_force_pushed', head_ref_deleted: 'prDrawer.verb.head_ref_deleted', head_ref_restored: 'prDrawer.verb.head_ref_restored',
  closed: 'prDrawer.verb.closed', merged: 'prDrawer.verb.merged', reopened: 'prDrawer.verb.reopened', ready_for_review: 'prDrawer.verb.ready_for_review',
  convert_to_draft: 'prDrawer.verb.convert_to_draft', review_requested: 'prDrawer.verb.review_requested', review_request_removed: 'prDrawer.verb.review_request_removed',
  assigned: 'prDrawer.verb.assigned', unassigned: 'prDrawer.verb.unassigned', deployed: 'prDrawer.verb.deployed', milestoned: 'prDrawer.verb.milestoned',
}
// 已知动词翻译，未知则回退到原始 verb 串
function verbLabel(verb?: string) {
  const k = VERB[verb || '']
  return k ? t(k) : (verb || '')
}

// diff 着色
type DiffLine = { t: 'file' | 'hunk' | 'add' | 'del' | 'meta' | 'ctx'; text: string }
const diffLines = computed<DiffLine[]>(() => {
  if (!diff.value) return []
  return diff.value.split('\n').map((line): DiffLine => {
    if (line.startsWith('diff --git')) return { t: 'file', text: line.replace('diff --git ', '') }
    if (line.startsWith('@@')) return { t: 'hunk', text: line }
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file') || line.startsWith('rename ') || line.startsWith('similarity ')) return { t: 'meta', text: line }
    if (line.startsWith('+')) return { t: 'add', text: line }
    if (line.startsWith('-')) return { t: 'del', text: line }
    return { t: 'ctx', text: line }
  })
})
const lineCls: Record<DiffLine['t'], string> = {
  file: 'text-highlighted font-medium bg-elevated px-3 py-1 mt-3 first:mt-0',
  hunk: 'text-dimmed px-3', add: 'text-success bg-success/10 px-3',
  del: 'text-error bg-error/10 px-3', meta: 'text-dimmed px-3', ctx: 'text-toned px-3',
}
</script>

<template>
  <USlideover v-model:open="open" :ui="{ content: 'w-[100vw] max-w-full min-w-0 md:w-[calc(100vw-15rem)] md:min-w-[640px] md:max-w-none' }">
    <template #content>
      <div class="h-full flex flex-col bg-default text-default">
        <!-- header -->
        <div class="px-6 py-5 border-b border-default shrink-0">
          <div v-if="detail" class="flex items-start justify-between gap-4">
            <div class="min-w-0">
              <div class="flex items-center flex-wrap gap-x-2 gap-y-0.5 text-xs text-dimmed">
                <span class="tabular-nums">#{{ detail.number }}</span>
                <span>·</span><span>{{ detail.author }}</span>
                <span>·</span><span class="font-mono break-all">{{ detail.branch }}</span>
              </div>
              <h2 class="text-lg font-medium mt-1 leading-snug">{{ detail.title }}</h2>
              <div class="text-xs text-dimmed mt-1 tabular-nums">
                {{ $t('prDrawer.filesCount', { count: detail.changedFiles }) }} ·
                <span class="text-success">+{{ detail.additions }}</span>
                <span class="text-error"> −{{ detail.deletions }}</span>
              </div>
            </div>
            <div class="flex items-center gap-3 shrink-0">
              <a :href="detail.url" target="_blank" class="text-xs text-muted hover:text-highlighted whitespace-nowrap">{{ $t('prDrawer.openInGithub') }}</a>
              <button class="text-dimmed hover:text-highlighted text-lg leading-none" @click="open = false">✕</button>
            </div>
          </div>
          <div v-else class="flex items-center justify-between">
            <span class="text-sm text-dimmed">{{ pending ? $t('common.loading') : error || $t('prDrawer.title') }}</span>
            <button class="text-dimmed hover:text-highlighted text-lg leading-none" @click="open = false">✕</button>
          </div>

          <!-- 实例级自动化开关：自动审核 / 自动修复（覆盖项目配置；翻开即重置该 PR 的回合数） -->
          <div v-if="detail" class="flex items-center flex-wrap gap-x-5 gap-y-1 mt-3 text-xs">
            <div class="flex items-center gap-2">
              <USwitch :model-value="reviewOnLocal" size="sm" @update:model-value="(v: boolean) => toggleAuto('reviewOn', v)" />
              <span class="select-none" :class="reviewOnLocal ? 'text-highlighted' : 'text-dimmed'">{{ $t('automation.prAutoReview') }}</span>
            </div>
            <div class="flex items-center gap-2">
              <USwitch :model-value="fixOnLocal" size="sm" @update:model-value="(v: boolean) => toggleAuto('fixOn', v)" />
              <span class="select-none" :class="fixOnLocal ? 'text-highlighted' : 'text-dimmed'">{{ $t('automation.prAutoFix') }}</span>
            </div>
            <span v-if="coolingMinLeft" class="text-warning">· {{ $t('automation.coolingHint', { n: coolingMinLeft }) }}</span>
            <span v-else-if="autoNoteText" class="text-highlighted">· {{ autoNoteText }}</span>
          </div>

          <!-- 子 tab：手机上 5 个 tab 会超出抽屉宽度 → 横向滚动(bleed 到抽屉边缘)，
               而不是撑破整个页面宽度(那会让手机 layout viewport 变宽、md 断点误触发、整体布局崩) -->
          <div v-if="detail" class="flex gap-5 md:gap-6 mt-4 text-sm overflow-x-auto -mx-6 px-6 md:mx-0 md:px-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <button class="pb-1 border-b-2 transition-colors shrink-0 whitespace-nowrap" :class="activeTab === 'review' ? 'border-inverted text-highlighted' : 'border-transparent text-dimmed hover:text-default'" @click="activeTab = 'review'">{{ $t('prDrawer.tabReview') }}</button>
            <button class="pb-1 border-b-2 transition-colors shrink-0 whitespace-nowrap" :class="activeTab === 'fix' ? 'border-inverted text-highlighted' : 'border-transparent text-dimmed hover:text-default'" @click="activeTab = 'fix'">{{ $t('prDrawer.tabFix') }}</button>
            <button class="pb-1 border-b-2 transition-colors shrink-0 whitespace-nowrap" :class="activeTab === 'timeline' ? 'border-inverted text-highlighted' : 'border-transparent text-dimmed hover:text-default'" @click="activeTab = 'timeline'">{{ $t('prDrawer.tabTimeline') }}</button>
            <button class="pb-1 border-b-2 transition-colors shrink-0 whitespace-nowrap" :class="activeTab === 'changes' ? 'border-inverted text-highlighted' : 'border-transparent text-dimmed hover:text-default'" @click="activeTab = 'changes'">{{ $t('prDrawer.tabChanges') }} <span class="text-dimmed">{{ detail.changedFiles }}</span></button>
            <button class="pb-1 border-b-2 transition-colors shrink-0 whitespace-nowrap" :class="activeTab === 'workflow' ? 'border-inverted text-highlighted' : 'border-transparent text-dimmed hover:text-default'" @click="activeTab = 'workflow'">{{ $t('automation.tab') }}</button>
          </div>
        </div>

        <!-- ── AI 审核 ── -->
        <ReviewPanel
          v-if="detail && activeTab === 'review' && prNumber"
          :project-id="projectId"
          :pr-number="prNumber"
          :review-id="reviewId"
          @created="emit('taskCreated')"
          @changed="emit('taskCreated')"
        />

        <!-- ── 修复 PR ── -->
        <div v-if="detail && activeTab === 'fix' && prNumber" class="flex-1 min-h-0 flex flex-col px-6 py-4">
          <FixPanel :project-id="projectId" :pr-number="prNumber" :fix-id="fixId" :active="activeTab === 'fix'" @changed="emit('taskCreated')" />
        </div>

        <!-- ── 时间线 ── -->
        <div v-if="detail && activeTab === 'timeline'" class="flex-1 overflow-y-auto px-6 py-5">
          <ol class="relative border-l border-default ml-3 space-y-5">
            <!-- 开场：PR 描述 -->
            <li class="pl-6 relative">
              <span class="absolute -left-[7px] top-1.5 w-3 h-3 rounded-full bg-inverted" />
              <div class="text-xs text-dimmed mb-1">
                <span class="text-default font-medium">{{ detail.author }}</span> {{ $t('prDrawer.openedPr') }} · {{ rel(detail.createdAt) }}
              </div>
              <div class="border border-default rounded-md p-3">
                <div v-if="detail.body" class="md-body" v-html="openingHtml" />
                <span v-else class="text-sm text-dimmed">{{ $t('prDrawer.noDescription') }}</span>
              </div>
            </li>

            <li v-for="(n, i) in nodes" :key="i" class="pl-6 relative">
              <!-- 评论 / review：卡片 -->
              <template v-if="n.kind === 'comment' || n.kind === 'review'">
                <span class="absolute -left-[7px] top-1.5 w-3 h-3 rounded-full" :class="n.isBot ? 'bg-accented' : 'bg-inverted'" />
                <div class="text-xs text-dimmed mb-1">
                  <span class="text-default font-medium">{{ n.actor }}</span>
                  <span v-if="n.isBot" class="ml-1 text-[10px] uppercase border border-default rounded px-1 text-dimmed">bot</span>
                  <span v-if="n.kind === 'review'" class="ml-1">{{ $t(REVIEW_STATE[n.state || ''] || 'prDrawer.review.generic') }}</span>
                  <span v-else class="ml-1">{{ $t('prDrawer.commentLabel') }}</span>
                  · {{ rel(n.at) }}
                </div>
                <div v-if="n.bodyHtml" class="border border-default rounded-md p-3 md-body" v-html="n.bodyHtml" />
              </template>

              <!-- commit -->
              <template v-else-if="n.kind === 'commit'">
                <span class="absolute -left-[6px] top-2 w-2.5 h-2.5 rounded-full bg-default border border-accented" />
                <div class="text-sm text-toned flex gap-2 items-baseline">
                  <span class="font-mono text-xs text-dimmed tabular-nums">{{ n.sha }}</span>
                  <span class="truncate">{{ n.message }}</span>
                </div>
              </template>

              <!-- 其它事件：紧凑灰行 -->
              <template v-else>
                <span class="absolute -left-[5px] top-2 w-2 h-2 rounded-full bg-accented" />
                <div class="text-xs text-dimmed">
                  <span class="text-toned">{{ n.actor }}</span>
                  {{ verbLabel(n.verb) }}
                  <span v-if="n.detail" class="text-muted">{{ n.detail }}</span>
                  · {{ rel(n.at) }}
                </div>
              </template>
            </li>
          </ol>
        </div>

        <!-- ── 改动 ── -->
        <div v-else-if="detail && activeTab === 'changes'" class="flex-1 overflow-y-auto">
          <section v-if="detail.files.length" class="px-6 py-4 border-b border-default">
            <div class="text-[10px] uppercase tracking-[0.15em] text-dimmed mb-2">{{ $t('prDrawer.changedFiles', { count: detail.files.length }) }}</div>
            <div v-for="f in detail.files" :key="f.path" class="flex justify-between gap-4 text-sm py-1">
              <span class="font-mono text-xs text-default truncate">{{ f.path }}</span>
              <span class="text-xs tabular-nums shrink-0">
                <span class="text-success">+{{ f.additions }}</span>
                <span class="text-error ml-1">−{{ f.deletions }}</span>
              </span>
            </div>
          </section>
          <section class="px-6 py-3">
            <p v-if="diffPending" class="py-6 text-sm text-dimmed">{{ $t('prDrawer.loadingDiff') }}</p>
            <DiffView v-else :diff="diff || ''" :truncated="diffTruncated" />
          </section>
        </div>

        <!-- ── 自动化工作流时间线 ── -->
        <div v-else-if="detail && activeTab === 'workflow'" class="flex-1 overflow-y-auto px-6 py-5">
          <p v-if="!wfEvents.length" class="py-16 text-center text-xs text-dimmed">
            {{ wfPending ? $t('common.loading') : $t('automation.noEvents') }}
          </p>
          <ol v-else class="relative border-l border-default ml-3 space-y-4">
            <li v-for="ev in wfEvents" :key="ev.id" class="pl-6 relative">
              <span class="absolute -left-[6px] top-1.5 w-2.5 h-2.5 rounded-full" :class="WF_DOT[ev.kind] || 'bg-accented'" />
              <div class="text-sm text-toned">{{ wfLabel(ev) }}</div>
              <div class="text-[11px] text-dimmed mt-0.5">{{ rel(ev.ts) }}</div>
            </li>
          </ol>
        </div>
      </div>
    </template>
  </USlideover>
</template>

<style>
.md-body { font-size: 0.875rem; line-height: 1.65; color: var(--ui-text-toned); word-break: break-word; }
.md-body > *:first-child { margin-top: 0; }
.md-body > *:last-child { margin-bottom: 0; }
.md-body h1, .md-body h2, .md-body h3, .md-body h4 { font-weight: 600; margin: 0.9em 0 0.4em; color: var(--ui-text-highlighted); }
.md-body h1 { font-size: 1.1rem; } .md-body h2 { font-size: 1rem; } .md-body h3 { font-size: 0.92rem; }
.md-body p { margin: 0.5em 0; }
.md-body ul { margin: 0.5em 0; padding-left: 1.3em; list-style: disc; }
.md-body ol { margin: 0.5em 0; padding-left: 1.3em; list-style: decimal; }
.md-body li { margin: 0.2em 0; }
.md-body code { background: var(--ui-bg-muted); padding: 0.1em 0.35em; border-radius: 3px; font-size: 0.85em; }
.md-body pre { background: var(--ui-bg-muted); padding: 0.7em; border-radius: 6px; overflow-x: auto; margin: 0.6em 0; }
.md-body pre code { background: none; padding: 0; }
.md-body a { color: var(--ui-text-highlighted); text-decoration: underline; }
.md-body blockquote { border-left: 2px solid var(--ui-border); padding-left: 0.8em; color: var(--ui-text-muted); margin: 0.5em 0; }
.md-body table { border-collapse: collapse; margin: 0.6em 0; font-size: 0.85em; }
.md-body th, .md-body td { border: 1px solid var(--ui-border); padding: 0.3em 0.6em; text-align: left; }
.md-body img { max-width: 100%; }
.md-body hr { border: 0; border-top: 1px solid var(--ui-border); margin: 0.8em 0; }
</style>

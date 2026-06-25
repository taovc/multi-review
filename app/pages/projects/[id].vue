<script setup lang="ts">
import type { Project } from '~core/db/schema'

type Pull = {
  number: number
  title: string
  author: string
  branch: string
  headSha: string
  state: string
  isDraft: boolean
  reviewDecision: string
  reviewsCount: number
  updatedAt: string
  additions: number
  deletions: number
  hasTask: boolean
  taskId: string | null
  taskStatus: string | null
  fixId: string | null
  fixStatus: string | null
  fixChatting: boolean
  authorUpdated: boolean
  reviewerUpdated: boolean
  hasWorktree: boolean
}

const { t, te } = useI18n()
const route = useRoute()
const projectId = computed(() => route.params.id as string)
const { data: project, refresh: refreshProject } = await useFetch<Project>(() => `/api/projects/${projectId.value}`)

const tab = ref<'pulls' | 'config'>('pulls')
const msg = ref('')

async function onProjectChanged() {
  await Promise.all([refreshProject(), refreshNuxtData('/api/projects')])
}
async function onProjectDeleted() {
  await refreshNuxtData('/api/projects')
  await navigateTo('/')
}

// PR 详情 drawer（含 AI 审核 + 修复 tab）
const drawerOpen = ref(false)
const drawerPr = ref<number | null>(null)
const drawerReviewId = ref<string | null>(null)
const drawerFixId = ref<string | null>(null)
const drawerTab = ref<string | undefined>(undefined)
function openDetail(prNumber: number, reviewId: string | null = null, fixId: string | null = null, tab?: string) {
  drawerPr.value = prNumber
  drawerReviewId.value = reviewId
  drawerFixId.value = fixId
  drawerTab.value = tab
  drawerOpen.value = true
}
async function onTaskCreated() {
  await refreshPulls()
  // drawer 开着时，把这个 PR 最新的 fixId 同步回来（验证表单刚建的 fix，重开 drawer 时别丢成空表单）
  if (drawerPr.value != null) {
    const fresh = pullsResp.value?.pulls.find((p) => p.number === drawerPr.value)
    if (fresh?.fixId) drawerFixId.value = fresh.fixId
  }
}

// ── 全部 PR：一次拉够（FETCH_LIMIT），所有维度前端过滤 + 前端分页（总数/翻页都跟着 filter 走）──
const PER_PAGE = 10
const FETCH_LIMIT = 100 // 后端单次上限；「进行中」一般全拉得到，「全部」范围拉最近 100
type PullsResp = { pulls: Pull[]; totalCount: number; hasNextPage: boolean; endCursor: string | null }
const pullsResp = ref<PullsResp | null>(null)
const pullsPending = ref(false)
const page = ref(0)

// PR status 是后端分页维度：只在 open/draft 范围内时让后端拉 open（默认进行中，不会被一堆 merged 淹没）；
// 一旦勾了 merged/closed 就拉 all，再前端按 fPr 细分。其它三维（作者/审核/修复）纯前端过滤当前页。
const fPr = ref<string[]>(['open', 'draft'])
const backendState = computed(() => {
  const f = fPr.value
  if (!f.length) return 'all'
  return f.every((k) => k === 'open' || k === 'draft') ? 'open' : 'all'
})

async function loadPulls() {
  pullsPending.value = true
  try {
    pullsResp.value = await $fetch<PullsResp>(`/api/projects/${projectId.value}/pulls`, {
      query: { state: backendState.value, first: FETCH_LIMIT },
    })
  } catch (e: any) {
    msg.value = e?.data?.statusMessage || e?.message || t('project.msg.fetchFailed')
  } finally {
    pullsPending.value = false
  }
}
function resetAndLoad() { page.value = 0; loadPulls() }
onMounted(resetAndLoad)
watch(backendState, resetAndLoad) // 切「进行中 ↔ 全部」范围 → 重新拉
async function refreshPulls() { await loadPulls() }
function nextPage() { if (page.value < pageCount.value - 1) page.value++ }
function prevPage() { if (page.value > 0) page.value-- }

// 自动刷新：页面可见时每 8s 拉一次 PR 列表。两个「已更新」标识在后端实时算（head sha / review 计数），
// 不需要后台 refresh-states，任何状态变化都会随列表刷新冒出来。
let pollTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  pollTimer = setInterval(() => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    refreshPulls()
  }, 8000)
})
onBeforeUnmount(() => { if (pollTimer) clearInterval(pollTimer) })

// ── 多维 filter（作者 / PR / 审核 / 修复，都多选，前端过滤）──
const fAuthors = ref<string[]>([])
const fReview = ref<string[]>([])
const fFix = ref<string[]>([])
const fWorktree = ref<string[]>([])
const authors = computed(() => {
  const s = new Set<string>()
  for (const p of pullsResp.value?.pulls ?? []) s.add(p.author)
  return [...s].sort()
})
type FilterKey = 'author' | 'pr' | 'review' | 'fix' | 'worktree'
const filterRefs = { author: fAuthors, pr: fPr, review: fReview, fix: fFix, worktree: fWorktree }
function toggleFilter(key: FilterKey, v: string) {
  const arr = filterRefs[key]
  arr.value = arr.value.includes(v) ? arr.value.filter((x) => x !== v) : [...arr.value, v]
}
// 一键全选 / 全不选该维度（已全选则清空，否则选满）
function toggleAll(key: FilterKey, opts: string[]) {
  const arr = filterRefs[key]
  arr.value = arr.value.length === opts.length ? [] : [...opts]
}
const anyFilter = computed(() => fAuthors.value.length || fPr.value.length || fReview.value.length || fFix.value.length || fWorktree.value.length)
function clearFilters() {
  fAuthors.value = []; fPr.value = []; fReview.value = []; fFix.value = []; fWorktree.value = []
}

const INFLIGHT = ['queued', 'cloning', 'reviewing', 'recheck_requested', 'rechecking']
function pullKey(p: Pull) {
  if (p.state === 'merged') return 'merged'
  if (p.state === 'closed') return 'closed'
  if (p.isDraft || p.state === 'draft') return 'draft'
  return 'open'
}
function reviewKey(p: Pull) {
  if (p.taskStatus) {
    if (INFLIGHT.includes(p.taskStatus)) return 'reviewing'
    if (p.taskStatus === 'posted') return 'posted'
    return 'draft'
  }
  if (p.reviewDecision === 'APPROVED') return 'approved'
  if (p.reviewDecision === 'CHANGES_REQUESTED') return 'changes'
  if (p.reviewsCount > 0) return 'reviewed'
  return 'none'
}
function fixKey(p: Pull) {
  return p.fixStatus ?? 'none'
}
function worktreeKey(p: Pull) {
  return p.hasWorktree ? 'has' : 'none'
}

const visiblePulls = computed(() => {
  let list = pullsResp.value?.pulls ?? []
  if (fAuthors.value.length) list = list.filter((p) => fAuthors.value.includes(p.author))
  if (fPr.value.length) list = list.filter((p) => fPr.value.includes(pullKey(p)))
  if (fReview.value.length) list = list.filter((p) => fReview.value.includes(reviewKey(p)))
  if (fFix.value.length) list = list.filter((p) => fFix.value.includes(fixKey(p)))
  if (fWorktree.value.length) list = list.filter((p) => fWorktree.value.includes(worktreeKey(p)))
  return list
})
// 前端分页：总数/翻页都基于过滤后的结果
const pageCount = computed(() => Math.max(1, Math.ceil(visiblePulls.value.length / PER_PAGE)))
const pagedPulls = computed(() => visiblePulls.value.slice(page.value * PER_PAGE, page.value * PER_PAGE + PER_PAGE))
watch([fAuthors, fReview, fFix, fWorktree], () => { page.value = 0 }) // 改 filter → 回第一页（fPr 走 backendState 的 reset）

// filter 可选项
const PR_OPTS = ['open', 'draft', 'merged', 'closed']
const REVIEW_OPTS = ['none', 'reviewing', 'reviewed', 'posted', 'approved', 'changes']
const FIX_OPTS = ['none', 'open', 'ready', 'pushing', 'pushed', 'error']
const WT_OPTS = ['has', 'none']

// ── 三列状态显示 ──
const PR_STATE: Record<string, { label: string; cls: string }> = {
  open: { label: 'status.pr.open', cls: 'text-default border-accented' },
  merged: { label: 'status.pr.merged', cls: 'text-highlighted border-accented' },
  closed: { label: 'status.pr.closed', cls: 'text-dimmed border-default' },
  draft: { label: 'status.pr.draft', cls: 'text-dimmed border-default' },
}
function pullBadge(p: Pull) {
  // 纯 GitHub 生命周期：open/draft/merged/closed（评审决定挪到 Review 列）
  return PR_STATE[p.isDraft ? 'draft' : p.state] ?? { label: 'status.pr.unknown', cls: 'text-dimmed border-default' }
}
function taskStatusLabel(s: string) {
  const k = `status.task.${s}`
  return te(k) ? t(k) : s
}
function fixStatusLabel(s: string) {
  const k = `status.fix.${s}`
  return te(k) ? t(k) : s
}
// Review 列：本系统审核任务态优先；否则 GitHub 评审决定 / 「已审核」；都无 → null（显示 —）
function reviewCell(p: Pull): { label: string; cls: string } | null {
  if (p.taskStatus) {
    const cls = p.taskStatus === 'error' ? 'text-highlighted font-medium' : INFLIGHT.includes(p.taskStatus) ? 'text-toned' : 'text-default'
    return { label: taskStatusLabel(p.taskStatus), cls }
  }
  if (p.reviewDecision === 'APPROVED') return { label: t('status.pr.approved'), cls: 'text-highlighted' }
  if (p.reviewDecision === 'CHANGES_REQUESTED') return { label: t('status.pr.changes'), cls: 'text-toned' }
  if (p.reviewsCount > 0) return { label: t('project.tag.reviewed'), cls: 'text-dimmed' }
  return null
}
function fixCell(p: Pull): { label: string; cls: string } | null {
  if (p.fixStatus) return { label: fixStatusLabel(p.fixStatus), cls: p.fixStatus === 'error' ? 'text-error font-medium' : 'text-toned' }
  return null
}
// filter 选项文案
function reviewOptLabel(k: string) {
  if (k === 'none') return t('project.reviewNone')
  if (k === 'reviewed') return t('project.tag.reviewed')
  if (k === 'approved') return t('status.pr.approved')
  if (k === 'changes') return t('status.pr.changes')
  const tk = `status.task.${k}`
  return te(tk) ? t(tk) : k
}
function fixOptLabel(k: string) {
  return k === 'none' ? t('project.fixNone') : fixStatusLabel(k)
}
function worktreeOptLabel(k: string) {
  return t(k === 'has' ? 'project.worktree.has' : 'project.worktree.none')
}
// filter 维度（sel 取 unref 数组用于显示 includes；toggle 走 toggleFilter）
const filterDims = computed(() => [
  { key: 'author' as const, label: t('project.col.author'), sel: fAuthors.value, opts: authors.value, fmt: (k: string) => k },
  { key: 'pr' as const, label: t('project.col.prStatus'), sel: fPr.value, opts: PR_OPTS, fmt: (k: string) => t('status.pr.' + k) },
  { key: 'review' as const, label: t('project.col.reviewStatus'), sel: fReview.value, opts: REVIEW_OPTS, fmt: reviewOptLabel },
  { key: 'fix' as const, label: t('project.col.fixStatus'), sel: fFix.value, opts: FIX_OPTS, fmt: fixOptLabel },
  { key: 'worktree' as const, label: t('project.col.worktree'), sel: fWorktree.value, opts: WT_OPTS, fmt: worktreeOptLabel },
])
</script>

<template>
  <div class="max-w-6xl mx-auto px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-12">
    <!-- 头 -->
    <div v-if="project" class="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div class="min-w-0">
        <h1 class="text-2xl sm:text-3xl font-light tracking-tight break-words">{{ project.name }}</h1>
        <p class="text-xs uppercase tracking-[0.15em] text-dimmed mt-2">{{ project.repo }} · {{ project.defaultBranch }}</p>
      </div>
      <span class="text-xs text-dimmed">{{ msg }}</span>
    </div>

    <!-- Tabs：只剩 全部 PR + 项目配置 -->
    <!-- overflow-y-hidden：overflow-x-auto 会把 y 轴也算成 auto，叠加 tab 的 -mb-px 会冒出多余的竖向滚动条 -->
    <div class="mt-8 sm:mt-10 flex gap-6 sm:gap-8 border-b border-default text-sm overflow-x-auto overflow-y-hidden">
      <button
        class="pb-3 -mb-px border-b-2 transition-colors"
        :class="tab === 'pulls' ? 'border-inverted text-highlighted' : 'border-transparent text-dimmed hover:text-default'"
        @click="tab = 'pulls'"
      >{{ $t('project.tabs.pulls') }}</button>
      <button
        class="pb-3 -mb-px border-b-2 transition-colors"
        :class="tab === 'config' ? 'border-inverted text-highlighted' : 'border-transparent text-dimmed hover:text-default'"
        @click="tab = 'config'"
      >{{ $t('project.tabs.config') }}</button>
    </div>

    <ProjectConfig v-if="tab === 'config' && project" :project="project" @changed="onProjectChanged" @deleted="onProjectDeleted" />

    <!-- ── 全部 PR ── -->
    <div v-show="tab === 'pulls'" class="mt-8">
      <!-- 多维 filter：每个维度一个独立下拉（点开是 multi-checkbox） -->
      <div class="flex items-center gap-2 flex-wrap">
        <UPopover v-for="dim in filterDims" :key="dim.key" :content="{ align: 'start' }">
          <UButton variant="outline" color="neutral" size="sm" trailing-icon="i-lucide-chevron-down" class="w-36 justify-between">
            <span class="truncate">{{ dim.label }}<span v-if="dim.sel.length" class="ml-1 text-dimmed">({{ dim.sel.length }})</span></span>
          </UButton>
          <template #content>
            <div class="w-52">
              <div v-if="dim.opts.length" class="flex items-center px-2.5 pt-2 pb-1.5 border-b border-default">
                <button class="text-xs text-dimmed hover:text-highlighted" @click="toggleAll(dim.key, dim.opts)">
                  {{ dim.sel.length === dim.opts.length ? $t('project.deselectAll') : $t('project.selectAll') }}
                </button>
              </div>
              <div class="p-2 max-h-80 overflow-auto">
                <label
                  v-for="o in dim.opts" :key="o"
                  class="flex items-center gap-2 cursor-pointer text-sm py-1 px-1.5 rounded hover:bg-elevated/50"
                >
                  <input type="checkbox" class="accent-neutral-900 dark:accent-neutral-100" :checked="dim.sel.includes(o)" @change="toggleFilter(dim.key, o)" />
                  <span :class="dim.sel.includes(o) ? 'text-highlighted' : 'text-toned'">{{ dim.fmt(o) }}</span>
                </label>
              </div>
            </div>
          </template>
        </UPopover>
        <button v-if="anyFilter" class="text-xs text-dimmed hover:text-highlighted ml-1" @click="clearFilters">{{ $t('project.clearFilter') }}</button>
        <UButton class="ml-auto" variant="ghost" color="neutral" size="sm" :loading="pullsPending" icon="i-lucide-refresh-cw" @click="refreshPulls()">{{ $t('project.refreshList') }}</UButton>
      </div>

      <!-- PR 列表：PR | 标题(固定宽·换行) | 作者 | PR状态 | 审核 | 修复 -->
      <div class="mt-3 overflow-x-auto">
        <div class="min-w-[46rem]">
        <div class="grid grid-cols-[3.5rem_minmax(20rem,1fr)_8rem_6rem_7rem_7rem] gap-x-4 px-1 pb-3 text-[10px] uppercase tracking-[0.15em] text-dimmed border-b border-inverted">
          <span>PR</span>
          <span>{{ $t('project.col.title') }}</span>
          <span>{{ $t('project.col.author') }}</span>
          <span class="text-center">{{ $t('project.col.prStatus') }}</span>
          <span class="text-center">{{ $t('project.col.reviewStatus') }}</span>
          <span class="text-center">{{ $t('project.col.fixStatus') }}</span>
        </div>
        <div
          v-for="p in pagedPulls"
          :key="p.number"
          class="grid grid-cols-[3.5rem_minmax(20rem,1fr)_8rem_6rem_7rem_7rem] gap-x-4 items-center px-1 h-16 border-b border-default text-sm cursor-pointer hover:bg-elevated/40 transition-colors"
          @click="openDetail(p.number, p.taskId, p.fixId)"
        >
          <span class="font-medium tabular-nums">#{{ p.number }}</span>
          <span class="text-default break-words leading-snug line-clamp-2">{{ p.title }}</span>
          <button class="text-xs text-muted hover:text-highlighted truncate text-left" @click.stop="toggleFilter('author', p.author)">{{ p.author }}</button>
          <!-- PR status -->
          <span class="text-center">
            <span class="inline-block whitespace-nowrap text-[10px] uppercase tracking-wider px-2 py-0.5 border rounded-full" :class="pullBadge(p).cls">{{ $t(pullBadge(p).label) }}</span>
          </span>
          <!-- Review status + 作者已更新 -->
          <span class="text-center text-xs flex flex-col items-center justify-center gap-0.5 leading-tight">
            <span v-if="reviewCell(p)" :class="reviewCell(p)!.cls">{{ reviewCell(p)!.label }}</span>
            <span v-else class="text-dimmed">—</span>
            <span v-if="p.authorUpdated" class="text-[9px] text-highlighted font-medium" :title="$t('project.authorUpdatedTitle')">● {{ $t('project.authorUpdated') }}</span>
          </span>
          <!-- Fix status：对话中（我已介入）直接接管为主状态，不再叠「已上传 / 审核已更新」；否则显示状态 +（可选）审核已更新 -->
          <span class="text-center text-xs flex flex-col items-center justify-center gap-0.5 leading-tight">
            <button
              v-if="p.fixChatting"
              class="text-toned font-medium flex items-center gap-1 hover:text-highlighted"
              :title="$t('project.chattingTitle')"
              @click.stop="openDetail(p.number, p.taskId, p.fixId, 'fix')"
            >
              <span class="inline-block w-1.5 h-1.5 rounded-full bg-inverted animate-pulse" />{{ $t('project.chatting') }}
            </button>
            <template v-else>
              <button v-if="fixCell(p)" :class="fixCell(p)!.cls" class="hover:text-highlighted" @click.stop="openDetail(p.number, p.taskId, p.fixId, 'fix')">{{ fixCell(p)!.label }}</button>
              <span v-else class="text-dimmed">—</span>
              <span v-if="p.reviewerUpdated" class="text-[9px] text-highlighted font-medium" :title="$t('project.reviewerUpdatedTitle')">● {{ $t('project.reviewerUpdated') }}</span>
            </template>
          </span>
        </div>
        <p v-if="!visiblePulls.length" class="py-16 text-center text-xs text-dimmed">
          {{ pullsPending ? $t('common.loading') : $t('project.noPulls') }}
        </p>

        <!-- 分页：总数 = 过滤后数量；只有多页才出翻页按钮 -->
        <div v-if="visiblePulls.length" class="flex items-center justify-between mt-5 text-xs text-dimmed">
          <span>{{ $t('project.pagination.summaryPages', { total: visiblePulls.length, page: page + 1, pages: pageCount }) }}</span>
          <div v-if="pageCount > 1" class="flex gap-4">
            <button class="hover:text-highlighted disabled:opacity-30" :disabled="page === 0 || pullsPending" @click="prevPage">{{ $t('project.pagination.prev') }}</button>
            <button class="hover:text-highlighted disabled:opacity-30" :disabled="page >= pageCount - 1 || pullsPending" @click="nextPage">{{ $t('project.pagination.next') }}</button>
          </div>
        </div>
        </div>
      </div>
    </div>

    <PrDetailDrawer v-model:open="drawerOpen" :project-id="projectId" :pr-number="drawerPr" :review-id="drawerReviewId" :fix-id="drawerFixId" :initial-tab="drawerTab" @task-created="onTaskCreated" />
  </div>
</template>

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
  worktreeStale: boolean
  autoReviewOn: boolean
  autoFixOn: boolean
  autoNote: string | null
  autoRound: number
  autoMaxRounds: number
  autoCoolingUntil: string | null
}

const { t, te } = useI18n()
const route = useRoute()
const projectId = computed(() => route.params.id as string)
const { data: project, refresh: refreshProject } = await useFetch<Project>(() => `/api/projects/${projectId.value}`)

const openSession = useOpenGlobalSession() // ?session=<runId> opens the assistant drawer on that session
const tab = ref<'pulls' | 'config'>('pulls')
const msg = ref('')
const automationOpen = ref(false)

async function onProjectChanged() {
  await Promise.all([refreshProject(), refreshNuxtData('/api/projects')])
}
async function onProjectDeleted() {
  await refreshNuxtData('/api/projects')
  await navigateTo('/')
}

// PR detail drawer (includes the AI review + fix tabs)
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
// The drawer's two automation switches follow the list's live data (the 8s poll refreshes the effective state/note/round count)
const drawerPull = computed(() => (drawerPr.value != null ? pullsResp.value?.pulls.find((p) => p.number === drawerPr.value) ?? null : null))
async function onTaskCreated() {
  await refreshPulls()
  // While the drawer is open, sync back this PR's latest fixId (so a fix just created from the verify form isn't lost as an empty form when the drawer reopens)
  if (drawerPr.value != null) {
    const fresh = pullsResp.value?.pulls.find((p) => p.number === drawerPr.value)
    if (fresh?.fixId) drawerFixId.value = fresh.fixId
  }
}

// ── All PRs: fetch enough in one go (FETCH_LIMIT), then filter and paginate on the client across every dimension (total/paging follow the filters) ──
const PER_PAGE = 10
const FETCH_LIMIT = 100 // backend per-request cap; the in-progress scope usually fits entirely, the "all" scope fetches the latest 100
type PullsResp = { pulls: Pull[]; totalCount: number; hasNextPage: boolean; endCursor: string | null }
const pullsResp = ref<PullsResp | null>(null)
const pullsPending = ref(false)
const page = ref(0)

// PR status is the backend's pagination dimension: while the selection stays within open/draft, ask the
// backend for open (the default is open only, drafts unchecked, so a pile of merged PRs can't drown it out);
// as soon as merged/closed is checked, fetch all and refine by fPr on the client. The other three
// dimensions (author/review/fix) filter the current page purely on the client.
const fPr = ref<string[]>(['open'])
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
watch(backendState, resetAndLoad) // switching between the in-progress and all scopes → refetch
async function refreshPulls() { await loadPulls() }
function nextPage() { if (page.value < pageCount.value - 1) page.value++ }
function prevPage() { if (page.value > 0) page.value-- }

// Auto-refresh: fetch the PR list every 8s while the page is visible. Both "updated" markers are computed
// live on the backend (head sha / review count), so no background refresh-states is needed — any state
// change surfaces with the list refresh.
let pollTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  const pr = Number(route.query.pr)
  if (pr) openDetail(pr, typeof route.query.review === 'string' ? route.query.review : null, typeof route.query.fix === 'string' ? route.query.fix : null, typeof route.query.tab === 'string' ? route.query.tab : undefined)
  if (typeof route.query.session === 'string' && route.query.session) openSession.value = route.query.session
  pollTimer = setInterval(() => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    refreshPulls()
  }, 8000)
})
onBeforeUnmount(() => { if (pollTimer) clearInterval(pollTimer) })

// ── Multi-dimension filters (author / PR / review / fix, all multi-select, filtered on the client) ──
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
// Select / deselect a whole dimension in one click (clears it when everything is already selected, otherwise selects all)
function toggleAll(key: FilterKey, opts: string[]) {
  const arr = filterRefs[key]
  arr.value = arr.value.length === opts.length ? [] : [...opts]
}
const anyFilter = computed(() => fAuthors.value.length || fPr.value.length || fReview.value.length || fFix.value.length || fWorktree.value.length)
function clearFilters() {
  fAuthors.value = []; fPr.value = []; fReview.value = []; fFix.value = []; fWorktree.value = []
}

const INFLIGHT = ['queued', 'cloning', 'reviewing', 'recheck_requested', 'rechecking', 'posting']
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
  if (!p.hasWorktree) return ['none']
  return p.worktreeStale ? ['has', 'stale'] : ['has']
}

const visiblePulls = computed(() => {
  let list = pullsResp.value?.pulls ?? []
  if (fAuthors.value.length) list = list.filter((p) => fAuthors.value.includes(p.author))
  if (fPr.value.length) list = list.filter((p) => fPr.value.includes(pullKey(p)))
  if (fReview.value.length) list = list.filter((p) => fReview.value.includes(reviewKey(p)))
  if (fFix.value.length) list = list.filter((p) => fFix.value.includes(fixKey(p)))
  if (fWorktree.value.length) list = list.filter((p) => worktreeKey(p).some((k) => fWorktree.value.includes(k)))
  return list
})
// Client-side pagination: total and paging are both based on the filtered result
const pageCount = computed(() => Math.max(1, Math.ceil(visiblePulls.value.length / PER_PAGE)))
const pagedPulls = computed(() => visiblePulls.value.slice(page.value * PER_PAGE, page.value * PER_PAGE + PER_PAGE))
watch([fAuthors, fReview, fFix, fWorktree], () => { page.value = 0 }) // changing a filter → back to page one (fPr resets through backendState)

// filter options
const PR_OPTS = ['open', 'draft', 'merged', 'closed']
const REVIEW_OPTS = ['none', 'reviewing', 'reviewed', 'posted', 'approved', 'changes']
const FIX_OPTS = ['none', 'open', 'ready', 'pushing', 'pushed', 'error']
const WT_OPTS = ['has', 'stale', 'none']

// ── The three status columns ──
const PR_STATE: Record<string, { label: string; cls: string }> = {
  open: { label: 'status.pr.open', cls: 'text-default border-accented' },
  merged: { label: 'status.pr.merged', cls: 'text-highlighted border-accented' },
  closed: { label: 'status.pr.closed', cls: 'text-dimmed border-default' },
  draft: { label: 'status.pr.draft', cls: 'text-dimmed border-default' },
}
function pullBadge(p: Pull) {
  // Pure GitHub lifecycle: open/draft/merged/closed (the review decision moved to the Review column)
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
// Review column: this system's review task state wins; otherwise GitHub's review decision / "reviewed"; neither → null (renders —)
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
// filter option labels
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
  if (k === 'has') return t('project.worktree.has')
  if (k === 'stale') return t('project.worktree.stale')
  return t('project.worktree.none')
}
// filter dimensions (sel is the unref'd array, used for the includes check when rendering; toggling goes through toggleFilter)
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
    <!-- header -->
    <div v-if="project" class="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div class="min-w-0">
        <h1 class="text-2xl sm:text-3xl font-light tracking-tight break-words">{{ project.name }}</h1>
        <p class="text-xs uppercase tracking-[0.15em] text-dimmed mt-2">{{ project.repo }} · {{ project.defaultBranch }}</p>
      </div>
      <span class="text-xs text-dimmed">{{ msg }}</span>
    </div>

    <!-- Tabs: only All PRs + project config remain -->
    <!-- overflow-y-hidden: overflow-x-auto also makes the y axis auto, which together with the tabs' -mb-px produces a stray vertical scrollbar -->
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

    <!-- ── All PRs ── -->
    <div v-show="tab === 'pulls'" class="mt-8">
      <!-- Multi-dimension filters: one dropdown per dimension (opens into a multi-checkbox list) -->
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
        <UButton class="ml-auto" variant="ghost" color="neutral" size="sm" icon="i-lucide-settings-2" @click="() => { automationOpen = true }">{{ $t('automation.configBtn') }}</UButton>
        <UButton variant="ghost" color="neutral" size="sm" :loading="pullsPending" icon="i-lucide-refresh-cw" @click="refreshPulls()">{{ $t('project.refreshList') }}</UButton>
      </div>

      <!-- PR list: PR | title (fixed width, wraps) | author | PR status | review | fix -->
      <div class="mt-3 overflow-x-auto">
        <div class="md:min-w-[46rem]">
        <!-- Column headers: desktop only (mobile renders cards, which don't need column names)-->
        <div class="hidden md:grid grid-cols-[3.5rem_minmax(20rem,1fr)_8rem_6rem_7rem_7rem] gap-x-4 px-1 pb-3 text-[10px] uppercase tracking-[0.15em] text-dimmed border-b border-inverted">
          <span>PR</span>
          <span>{{ $t('project.col.title') }}</span>
          <span>{{ $t('project.col.author') }}</span>
          <span class="text-center">{{ $t('project.col.prStatus') }}</span>
          <span class="text-center">{{ $t('project.col.reviewStatus') }}</span>
          <span class="text-center">{{ $t('project.col.fixStatus') }}</span>
        </div>
        <!-- Mobile = card (flex-col), desktop = 6-column grid. The two md:contents wrappers dissolve on
             desktop so their children land directly in the grid columns; on mobile they each form a
             group (title group / status group). -->
        <div
          v-for="p in pagedPulls"
          :key="p.number"
          class="flex flex-col gap-2 py-3 px-1 border-b border-default text-sm cursor-pointer hover:bg-elevated/40 transition-colors md:grid md:grid-cols-[3.5rem_minmax(20rem,1fr)_8rem_6rem_7rem_7rem] md:gap-x-4 md:items-center md:py-0 md:h-16"
          @click="openDetail(p.number, p.taskId, p.fixId)"
        >
          <!-- PR# + title -->
          <div class="flex items-baseline gap-2 md:contents">
            <span class="font-medium tabular-nums shrink-0">#{{ p.number }}</span>
            <span class="text-default break-words leading-snug line-clamp-2">{{ p.title }}</span>
          </div>
          <!-- Author + the three statuses: on mobile they flex-wrap into a row of small tags, on desktop each takes a column -->
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1 md:contents">
            <button class="text-xs text-muted hover:text-highlighted truncate text-left" @click.stop="toggleFilter('author', p.author)">{{ p.author }}</button>
            <!-- PR status -->
            <span class="md:text-center">
              <span class="inline-block whitespace-nowrap text-[10px] uppercase tracking-wider px-2 py-0.5 border rounded-full" :class="pullBadge(p).cls">{{ $t(pullBadge(p).label) }}</span>
            </span>
            <!-- Review status + author updated -->
            <span class="text-xs flex items-center gap-1 leading-tight md:flex-col md:items-center md:justify-center md:gap-0.5 md:text-center">
              <span v-if="reviewCell(p)" :class="reviewCell(p)!.cls">{{ reviewCell(p)!.label }}</span>
              <span v-else class="text-dimmed">—</span>
              <span v-if="p.authorUpdated" class="text-[9px] text-highlighted font-medium" :title="$t('project.authorUpdatedTitle')">● {{ $t('project.authorUpdated') }}</span>
            </span>
            <!-- Fix status: "chatting" (I've stepped in) takes over as the main status; otherwise show the status + (optionally) reviewer updated -->
            <span class="text-xs flex items-center gap-1 leading-tight md:flex-col md:items-center md:justify-center md:gap-0.5 md:text-center">
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
        </div>
        <p v-if="!visiblePulls.length" class="py-16 text-center text-xs text-dimmed">
          {{ pullsPending ? $t('common.loading') : $t('project.noPulls') }}
        </p>

        <!-- Pagination: total = the filtered count; the paging buttons only appear when there is more than one page -->
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

    <PrDetailDrawer
      v-model:open="drawerOpen" :project-id="projectId" :pr-number="drawerPr"
      :review-id="drawerReviewId" :fix-id="drawerFixId" :initial-tab="drawerTab"
      :auto-review-on="drawerPull?.autoReviewOn ?? false" :auto-fix-on="drawerPull?.autoFixOn ?? false"
      :auto-note="drawerPull?.autoNote ?? null" :auto-round="drawerPull?.autoRound ?? 0" :auto-max-rounds="drawerPull?.autoMaxRounds ?? 2"
      :auto-cooling-until="drawerPull?.autoCoolingUntil ?? null"
      @task-created="onTaskCreated"
    />
    <AutomationDialog v-model:open="automationOpen" :project-id="projectId" :authors="authors" @saved="refreshPulls()" />
  </div>
</template>

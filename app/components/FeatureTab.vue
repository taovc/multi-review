<script setup lang="ts">
// Feature development (single-phase, native): "start development" in the top right → opens the drawer;
// the task is only created once the first message is sent. Open a row to see progress / continue / open a PR.
// The list matches the "all PRs" style (header row + wrapping title + pagination), with columns for
// feature development: title / status / PR / updated at.
const props = defineProps<{ projectId: string }>()
const { t, locale } = useI18n()

type FeatureTask = {
  id: string; title: string | null; description: string; status: string
  prUrl: string | null; prNumber: number | null; updatedAt: string
}

const { data: tasks, refresh } = await useFetch<FeatureTask[]>(() => `/api/projects/${props.projectId}/features`)
const drawerOpen = ref(false)
const activeId = ref<string | null>(null)

// Poll-refresh the list while tasks are in progress (working/awaiting) — this also surfaces titles generated in the background
let pollTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => { pollTimer = setInterval(() => { if (document.visibilityState !== 'hidden') refresh() }, 8000) })
onBeforeUnmount(() => { if (pollTimer) clearInterval(pollTimer) })

// Pagination (client-side slicing; there are few feature tasks and the list comes from the local DB) — same pagination UI as "all PRs".
const PER_PAGE = 15
const page = ref(0)
const pageCount = computed(() => Math.max(1, Math.ceil((tasks.value?.length ?? 0) / PER_PAGE)))
const pagedTasks = computed(() => (tasks.value ?? []).slice(page.value * PER_PAGE, page.value * PER_PAGE + PER_PAGE))
watch(() => tasks.value?.length, () => { if (page.value >= pageCount.value) page.value = Math.max(0, pageCount.value - 1) })
function prevPage() { if (page.value > 0) page.value-- }
function nextPage() { if (page.value < pageCount.value - 1) page.value++ }

const STATUS: Record<string, { label: string; cls: string }> = {
  working: { label: 'feature.status.working', cls: 'text-toned border-accented' },
  awaiting: { label: 'feature.status.awaiting', cls: 'text-warning border-warning/40' },
  opened: { label: 'feature.status.opened', cls: 'text-success border-success/40' },
  error: { label: 'feature.status.error', cls: 'text-error border-error/40' },
}
function badge(s: string) { return STATUS[s] ?? { label: s, cls: 'text-dimmed border-default' } }
function fmt(iso: string) { return new Date(iso).toLocaleString(locale.value, { hour12: false }) }

// New task: just open the drawer (activeId=null); it is only really created once the first message is sent (see FeatureDrawer). Close it anytime without typing and nothing is persisted.
function startNew() { activeId.value = null; drawerOpen.value = true }
function openTask(id: string) { activeId.value = id; drawerOpen.value = true }
// The drawer's first message created a task → switch to it + refresh the list.
function refreshList() { void refresh() }
function onCreated(id: string) { activeId.value = id; refreshList() }
function onDeleted(id: string) {
  tasks.value = (tasks.value ?? []).filter((task) => task.id !== id)
  if (activeId.value === id) activeId.value = null
  drawerOpen.value = false
  refreshList()
}
</script>

<template>
  <div class="mt-8">
    <!-- Top: hint + "start development" in the top right -->
    <div class="flex items-center gap-3">
      <p class="text-xs text-dimmed">{{ $t('feature.composerHint') }}</p>
      <button
        class="ml-auto shrink-0 text-sm bg-inverted text-inverted px-5 py-2 rounded hover:bg-inverted/90"
        @click="startNew"
      >{{ $t('feature.start') }}</button>
    </div>

    <!-- List: title (fixed width, wrapping) | status | PR | updated at -->
    <div class="mt-6 overflow-x-auto">
      <div class="md:min-w-[38rem]">
        <!-- Column header: desktop only (mobile renders cards, which need no column names) -->
        <div class="hidden md:grid grid-cols-[minmax(16rem,1fr)_7rem_5rem_9rem] gap-x-4 px-1 pb-3 text-[10px] uppercase tracking-[0.15em] text-dimmed border-b border-inverted">
          <span>{{ $t('feature.col.title') }}</span>
          <span class="text-center">{{ $t('feature.col.status') }}</span>
          <span class="text-center">{{ $t('feature.col.pr') }}</span>
          <span class="text-right">{{ $t('feature.col.updated') }}</span>
        </div>
        <!-- Mobile = card (flex-col), desktop = 4-column grid. On desktop, status/PR/updated at use
             md:contents to dissolve into the grid and take one column each; on mobile they group and
             flex-wrap into a row of small tags. -->
        <div
          v-for="taskItem in pagedTasks" :key="taskItem.id"
          class="flex flex-col gap-2 py-3 px-1 border-b border-default text-sm cursor-pointer hover:bg-elevated/40 transition-colors md:grid md:grid-cols-[minmax(16rem,1fr)_7rem_5rem_9rem] md:gap-x-4 md:items-center md:min-h-16"
          @click="openTask(taskItem.id)"
        >
          <span class="text-default break-words leading-snug line-clamp-2">{{ taskItem.title || taskItem.description }}</span>
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs md:contents">
            <span class="md:text-center">
              <span class="inline-block whitespace-nowrap text-[10px] uppercase tracking-wider px-2 py-0.5 border rounded-full" :class="badge(taskItem.status).cls">{{ $t(badge(taskItem.status).label) }}</span>
            </span>
            <span class="md:text-center">
              <a v-if="taskItem.prUrl" :href="taskItem.prUrl" target="_blank" class="text-muted hover:text-highlighted" @click.stop>#{{ taskItem.prNumber }}</a>
              <span v-else class="text-dimmed">—</span>
            </span>
            <span class="text-dimmed tabular-nums md:text-right">{{ fmt(taskItem.updatedAt) }}</span>
          </div>
        </div>

        <p v-if="!tasks?.length" class="py-16 text-center text-xs text-dimmed">{{ $t('feature.empty') }}</p>

        <!-- Pagination: same as "all PRs" -->
        <div v-if="tasks?.length" class="flex items-center justify-between mt-5 text-xs text-dimmed">
          <span>{{ $t('project.pagination.summaryPages', { total: tasks.length, page: page + 1, pages: pageCount }) }}</span>
          <div v-if="pageCount > 1" class="flex gap-4">
            <button class="hover:text-highlighted disabled:opacity-30" :disabled="page === 0" @click="prevPage">{{ $t('project.pagination.prev') }}</button>
            <button class="hover:text-highlighted disabled:opacity-30" :disabled="page >= pageCount - 1" @click="nextPage">{{ $t('project.pagination.next') }}</button>
          </div>
        </div>
      </div>
    </div>

    <FeatureDrawer v-model:open="drawerOpen" :project-id="projectId" :feature-id="activeId" @changed="refreshList" @created="onCreated" @deleted="onDeleted" />
  </div>
</template>

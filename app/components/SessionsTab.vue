<script setup lang="ts">
// Feature-branch sessions of a project (workspace branch_worktree): the list + a drawer with the shared SessionView.
// "Start" opens an empty drawer; the run is created when the first message is sent.
const props = defineProps<{ projectId: string; openId?: string | null }>()
const { locale } = useI18n()

type RunRow = { id: string; title: string | null; description: string | null; status: string; busy: boolean; prUrl: string | null; prNumber: number | null; branch: string | null; updatedAt: string }
type ListResp = { runs: RunRow[]; total: number; page: number; pageSize: number; hasNext: boolean }

const page = ref(0)
const PER_PAGE = 15
const { data, refresh } = await useFetch<ListResp>(() => `/api/runs?workspaceType=branch_worktree&projectId=${props.projectId}&page=${page.value}&pageSize=${PER_PAGE}`)
const drawerOpen = ref(false)
const activeId = ref<string | null>(null)
const pageCount = computed(() => Math.max(1, Math.ceil((data.value?.total ?? 0) / PER_PAGE)))

let pollTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => { pollTimer = setInterval(() => { if (document.visibilityState !== 'hidden') refresh() }, 8000) })
onBeforeUnmount(() => { if (pollTimer) clearInterval(pollTimer) })
// ?session= deep link (inbox)
watch(() => props.openId, (id) => { if (id) { activeId.value = id; drawerOpen.value = true } }, { immediate: true })

function badge(r: RunRow): { label: string; cls: string } {
  if (r.prUrl) return { label: 'feature.status.opened', cls: 'text-success border-success/40' }
  if (r.status === 'error') return { label: 'feature.status.error', cls: 'text-error border-error/40' }
  if (r.status === 'awaiting_input') return { label: 'feature.status.awaiting', cls: 'text-warning border-warning/40' }
  return { label: 'feature.status.working', cls: 'text-toned border-accented' }
}
function fmt(iso: string) { return new Date(iso).toLocaleString(locale.value, { hour12: false }) }
function startNew() { activeId.value = null; drawerOpen.value = true }
function openRun(id: string) { activeId.value = id; drawerOpen.value = true }
function onCreated(id: string) { activeId.value = id; void refresh() }
function onDeleted() { activeId.value = null; drawerOpen.value = false; void refresh() }
const activeTitle = computed(() => data.value?.runs.find((r) => r.id === activeId.value))
</script>

<template>
  <div class="mt-8">
    <div class="flex items-center gap-3">
      <p class="text-xs text-dimmed">{{ $t('feature.composerHint') }}</p>
      <button class="ml-auto shrink-0 text-sm bg-inverted text-inverted px-5 py-2 rounded hover:bg-inverted/90" @click="startNew">{{ $t('feature.start') }}</button>
    </div>

    <div class="mt-6 overflow-x-auto">
      <div class="md:min-w-[38rem]">
        <div class="hidden md:grid grid-cols-[minmax(16rem,1fr)_7rem_5rem_9rem] gap-x-4 px-1 pb-3 text-[10px] uppercase tracking-[0.15em] text-dimmed border-b border-inverted">
          <span>{{ $t('feature.col.title') }}</span>
          <span class="text-center">{{ $t('feature.col.status') }}</span>
          <span class="text-center">{{ $t('feature.col.pr') }}</span>
          <span class="text-right">{{ $t('feature.col.updated') }}</span>
        </div>
        <div
          v-for="r in data?.runs ?? []" :key="r.id"
          class="flex flex-col gap-2 py-3 px-1 border-b border-default text-sm cursor-pointer hover:bg-elevated/40 transition-colors md:grid md:grid-cols-[minmax(16rem,1fr)_7rem_5rem_9rem] md:gap-x-4 md:items-center md:min-h-16"
          @click="openRun(r.id)"
        >
          <span class="text-default break-words leading-snug line-clamp-2">{{ r.title || r.description }}</span>
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs md:contents">
            <span class="md:text-center">
              <span class="inline-block whitespace-nowrap text-[10px] uppercase tracking-wider px-2 py-0.5 border rounded-full" :class="badge(r).cls">{{ $t(badge(r).label) }}</span>
              <span v-if="r.busy" class="ml-1 inline-block w-1.5 h-1.5 rounded-full bg-inverted animate-pulse align-middle" />
            </span>
            <span class="md:text-center">
              <a v-if="r.prUrl" :href="r.prUrl" target="_blank" class="text-muted hover:text-highlighted" @click.stop>#{{ r.prNumber }}</a>
              <span v-else class="text-dimmed">—</span>
            </span>
            <span class="text-dimmed tabular-nums md:text-right">{{ fmt(r.updatedAt) }}</span>
          </div>
        </div>
        <p v-if="!data?.runs.length" class="py-16 text-center text-xs text-dimmed">{{ $t('feature.empty') }}</p>
        <div v-if="data?.total" class="flex items-center justify-between mt-5 text-xs text-dimmed">
          <span>{{ $t('project.pagination.summaryPages', { total: data.total, page: page + 1, pages: pageCount }) }}</span>
          <div v-if="pageCount > 1" class="flex gap-4">
            <button class="hover:text-highlighted disabled:opacity-30" :disabled="page === 0" @click="page--">{{ $t('project.pagination.prev') }}</button>
            <button class="hover:text-highlighted disabled:opacity-30" :disabled="!data.hasNext" @click="page++">{{ $t('project.pagination.next') }}</button>
          </div>
        </div>
      </div>
    </div>

    <USlideover v-model:open="drawerOpen" :ui="{ content: 'w-[100vw] max-w-full min-w-0 md:w-[calc(100vw-15rem)] md:min-w-[640px] md:max-w-none' }">
      <template #content>
        <div class="h-full flex flex-col bg-default text-default">
          <div class="shrink-0 flex items-center gap-3 px-6 py-4 border-b border-default">
            <h2 class="text-base font-medium truncate min-w-0 flex-1">{{ activeTitle ? (activeTitle.title || activeTitle.description || $t('feature.tab')) : $t('feature.newTitle') }}</h2>
            <button class="text-dimmed hover:text-highlighted text-lg leading-none shrink-0" @click="drawerOpen = false">✕</button>
          </div>
          <div class="flex-1 min-h-0 flex flex-col px-6 py-4">
            <SessionView :run-id="activeId" workspace-type="branch_worktree" :project-id="projectId" :active="drawerOpen" @created="onCreated" @changed="refresh" @deleted="onDeleted" />
          </div>
        </div>
      </template>
    </USlideover>
  </div>
</template>

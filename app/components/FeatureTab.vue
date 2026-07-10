<script setup lang="ts">
// Feature 开发（单段式原生）：右上角「开始开发」→ 打开抽屉、输入首条消息才建任务；列表点开看进度/继续/开 PR。
// 列表样式与「全部 PR」对齐（表头 + 换行标题 + 翻页），列按 feature 开发语义：标题 / 状态 / PR / 更新时间。
const props = defineProps<{ projectId: string }>()
const { t, locale } = useI18n()

type FeatureTask = {
  id: string; title: string | null; description: string; status: string
  prUrl: string | null; prNumber: number | null; updatedAt: string
}

const { data: tasks, refresh } = await useFetch<FeatureTask[]>(() => `/api/projects/${props.projectId}/features`)
const drawerOpen = ref(false)
const activeId = ref<string | null>(null)

// 进行中（working/awaiting）时轮询刷新列表（也让后台生成的标题及时冒出来）
let pollTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => { pollTimer = setInterval(() => { if (document.visibilityState !== 'hidden') refresh() }, 8000) })
onBeforeUnmount(() => { if (pollTimer) clearInterval(pollTimer) })

// 翻页（客户端切片；feature 任务量小、列表来自本地 DB）——和「全部 PR」同款翻页 UI。
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

// 新任务：只开抽屉（activeId=null），输入首条消息才真正创建（见 FeatureDrawer）。不输入随时可关，不落库。
function startNew() { activeId.value = null; drawerOpen.value = true }
function openTask(id: string) { activeId.value = id; drawerOpen.value = true }
// 抽屉里首条消息创建了任务 → 切到它 + 刷新列表。
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
    <!-- 顶部：说明 + 右上角「开始开发」 -->
    <div class="flex items-center gap-3">
      <p class="text-xs text-dimmed">{{ $t('feature.composerHint') }}</p>
      <button
        class="ml-auto shrink-0 text-sm bg-inverted text-inverted px-5 py-2 rounded hover:bg-inverted/90"
        @click="startNew"
      >{{ $t('feature.start') }}</button>
    </div>

    <!-- 列表：标题(固定宽·换行) | 状态 | PR | 更新时间 -->
    <div class="mt-6 overflow-x-auto">
      <div class="md:min-w-[38rem]">
        <!-- 列头：仅桌面显示（手机是卡片，不需要列名）-->
        <div class="hidden md:grid grid-cols-[minmax(16rem,1fr)_7rem_5rem_9rem] gap-x-4 px-1 pb-3 text-[10px] uppercase tracking-[0.15em] text-dimmed border-b border-inverted">
          <span>{{ $t('feature.col.title') }}</span>
          <span class="text-center">{{ $t('feature.col.status') }}</span>
          <span class="text-center">{{ $t('feature.col.pr') }}</span>
          <span class="text-right">{{ $t('feature.col.updated') }}</span>
        </div>
        <!-- 手机=卡片(flex-col)，桌面=4 列网格。状态/PR/更新时间在桌面用 md:contents
             「消融」进网格各占一列；手机上成组 flex-wrap 成一行小标签。 -->
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

        <!-- 分页：和「全部 PR」同款 -->
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

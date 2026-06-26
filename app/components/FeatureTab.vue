<script setup lang="ts">
// Feature 开发闭环 tab:描述需求 → 列表(状态) → 点开抽屉看方案/批准/实现/开 PR。
const props = defineProps<{ projectId: string }>()
const { t, te, locale } = useI18n()
const toast = useToast()

type FeatureTask = {
  id: string; title: string | null; description: string; status: string
  prUrl: string | null; prNumber: number | null; updatedAt: string
}

const { data: tasks, refresh } = await useFetch<FeatureTask[]>(() => `/api/projects/${props.projectId}/features`)
const desc = ref('')
const creating = ref(false)
const drawerOpen = ref(false)
const activeId = ref<string | null>(null)

// 进行中(analyzing/building)时轮询刷新列表
let pollTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => { pollTimer = setInterval(() => { if (document.visibilityState !== 'hidden') refresh() }, 8000) })
onBeforeUnmount(() => { if (pollTimer) clearInterval(pollTimer) })

const STATUS: Record<string, { label: string; cls: string }> = {
  analyzing: { label: 'feature.status.analyzing', cls: 'text-toned border-accented' },
  planned: { label: 'feature.status.planned', cls: 'text-highlighted border-inverted' },
  building: { label: 'feature.status.building', cls: 'text-toned border-accented' },
  built: { label: 'feature.status.built', cls: 'text-highlighted border-inverted' },
  opened: { label: 'feature.status.opened', cls: 'text-success border-success/40' },
  error: { label: 'feature.status.error', cls: 'text-error border-error/40' },
}
function badge(s: string) { return STATUS[s] ?? { label: s, cls: 'text-dimmed border-default' } }
function fmt(iso: string) { return new Date(iso).toLocaleString(locale.value, { hour12: false }) }

async function create() {
  const d = desc.value.trim()
  if (!d || creating.value) return
  creating.value = true
  try {
    const res = await $fetch<{ id: string }>(`/api/projects/${props.projectId}/features`, { method: 'POST', body: { description: d } })
    desc.value = ''
    await refresh()
    activeId.value = res.id
    drawerOpen.value = true
  } catch (e: any) {
    toast.add({ title: e?.data?.statusMessage || t('common.failed'), color: 'error', icon: 'i-lucide-triangle-alert' })
  } finally { creating.value = false }
}
function openTask(id: string) { activeId.value = id; drawerOpen.value = true }
</script>

<template>
  <div class="mt-8">
    <!-- 新需求 -->
    <div class="max-w-3xl">
      <p class="text-xs text-dimmed mb-2">{{ $t('feature.composerHint') }}</p>
      <textarea
        v-model="desc" rows="3" :placeholder="$t('feature.composerPlaceholder')"
        class="w-full text-sm border border-default rounded px-3 py-2 resize-y outline-none focus:border-inverted"
      />
      <div class="mt-2">
        <button
          class="text-sm bg-inverted text-inverted px-5 py-2 rounded hover:bg-inverted/90 disabled:opacity-40"
          :disabled="!desc.trim() || creating" @click="create"
        >{{ creating ? $t('feature.creating') : $t('feature.start') }}</button>
      </div>
    </div>

    <!-- 列表 -->
    <div class="mt-8">
      <div v-if="!tasks?.length" class="text-xs text-dimmed py-8">{{ $t('feature.empty') }}</div>
      <div
        v-for=" taskItem in tasks ?? []" :key="taskItem.id"
        class="flex items-center gap-3 py-3 border-b border-default text-sm cursor-pointer hover:bg-elevated/40 px-1 transition-colors"
        @click="openTask(taskItem.id)"
      >
        <span class="flex-1 min-w-0 truncate text-default">{{ taskItem.title || taskItem.description }}</span>
        <a v-if="taskItem.prUrl" :href="taskItem.prUrl" target="_blank" class="text-xs text-muted hover:text-highlighted shrink-0" @click.stop>#{{ taskItem.prNumber }}</a>
        <span class="shrink-0 text-[10px] uppercase tracking-wider px-2 py-0.5 border rounded-full whitespace-nowrap" :class="badge(taskItem.status).cls">{{ $t(badge(taskItem.status).label) }}</span>
        <span class="shrink-0 text-xs text-dimmed w-36 text-right hidden sm:block">{{ fmt(taskItem.updatedAt) }}</span>
      </div>
    </div>

    <FeatureDrawer v-model:open="drawerOpen" :feature-id="activeId" @changed="refresh" />
  </div>
</template>

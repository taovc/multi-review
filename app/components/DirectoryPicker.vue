<script setup lang="ts">
// 服务端目录选择器：浏览运行 PR Cockpit 那台机器的文件系统，挑一个本地 git 克隆目录。
// 选中的目录若是 git 仓库，连带它的 origin → owner/repo 一起回填。
interface Entry {
  name: string
  path: string
  isGit: boolean
}
interface BrowseResult {
  path: string
  parent: string | null
  home: string
  currentIsGit: boolean
  repo: string | null
  entries: Entry[]
}

const open = defineModel<boolean>('open', { required: true })
const props = defineProps<{ initialPath?: string }>()
const emit = defineEmits<{ select: [payload: { path: string; repo: string | null }] }>()

const current = ref('')
const parent = ref<string | null>(null)
const home = ref('')
const currentIsGit = ref(false)
const repo = ref<string | null>(null)
const entries = ref<Entry[]>([])
const pathInput = ref('')
const loading = ref(false)
const error = ref('')

async function load(p?: string) {
  loading.value = true
  error.value = ''
  currentIsGit.value = false // 先清掉上一目录的 git 提示，避免加载中显示过期的 owner/repo
  repo.value = null
  try {
    const r = await $fetch<BrowseResult>('/api/fs/browse', { query: { path: p ?? '' } })
    current.value = r.path
    parent.value = r.parent
    home.value = r.home
    currentIsGit.value = r.currentIsGit
    repo.value = r.repo
    entries.value = r.entries
    pathInput.value = r.path
  } catch (e: any) {
    error.value = e?.data?.statusMessage || e?.message || 'Failed'
  } finally {
    loading.value = false
  }
}

// 打开时从 initialPath（已填的值）或上次位置开始。
watch(open, (v) => {
  if (v) load(props.initialPath || current.value || undefined)
})

// 路径框里可能手敲了路径却没回车 → 点「选择」时先按它加载校验，确认有效再保存；
// 无效（404 等）就停在错误态、不把上一个目录当成选择结果。
async function choose() {
  if (pathInput.value.trim() && pathInput.value !== current.value) {
    await load(pathInput.value)
    if (error.value) return
  }
  emit('select', { path: current.value, repo: repo.value })
  open.value = false
}
</script>

<template>
  <BaseModal v-model:open="open" :title="$t('layout.picker.title')">
    <div class="space-y-3">
      <!-- 当前路径：可编辑，回车直接跳转 -->
      <div class="flex items-center gap-2">
        <button
          class="text-dimmed hover:text-highlighted disabled:opacity-30 text-sm shrink-0 px-1.5 py-1 border border-default rounded"
          :disabled="!parent || loading"
          :title="$t('layout.picker.parent')"
          @click="parent && load(parent)"
        >
          ↑
        </button>
        <button
          class="text-dimmed hover:text-highlighted disabled:opacity-30 text-sm shrink-0 px-1.5 py-1 border border-default rounded"
          :disabled="loading"
          :title="$t('layout.picker.home')"
          @click="load(home)"
        >
          ⌂
        </button>
        <input
          v-model="pathInput"
          class="flex-1 min-w-0 text-xs font-mono border-b border-default focus:border-inverted outline-none py-1 placeholder:text-dimmed"
          :placeholder="$t('layout.picker.pathPlaceholder')"
          @keydown.enter="load(pathInput)"
        />
      </div>

      <!-- 子目录列表 -->
      <div class="h-64 overflow-y-auto border border-default rounded divide-y divide-default">
        <p v-if="loading" class="px-3 py-3 text-xs text-dimmed">{{ $t('common.loading') }}</p>
        <p v-else-if="error" class="px-3 py-3 text-xs text-error">{{ error }}</p>
        <p v-else-if="!entries.length" class="px-3 py-3 text-xs text-dimmed">{{ $t('layout.picker.empty') }}</p>
        <button
          v-for="e in entries"
          v-else
          :key="e.path"
          class="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-muted hover:text-highlighted hover:bg-elevated/50 transition-colors"
          @click="load(e.path)"
        >
          <span class="text-dimmed">{{ e.isGit ? '◆' : '▸' }}</span>
          <span class="truncate flex-1">{{ e.name }}</span>
          <span v-if="e.isGit" class="text-[10px] uppercase tracking-wide text-dimmed shrink-0">git</span>
        </button>
      </div>

      <!-- 当前目录是 git 仓库时，提示会一并带出 owner/repo -->
      <p v-if="currentIsGit" class="text-xs text-dimmed">
        <span class="text-dimmed">◆ git ·</span>
        <template v-if="repo"> {{ $t('layout.picker.repoDetected') }} <span class="font-mono text-muted">{{ repo }}</span></template>
        <template v-else> {{ $t('layout.picker.repoUnknown') }}</template>
      </p>
    </div>

    <template #footer>
      <button class="text-sm text-muted hover:text-highlighted px-3" @click="open = false">{{ $t('common.cancel') }}</button>
      <button
        class="text-sm bg-inverted text-inverted px-4 py-2 hover:bg-inverted/90 disabled:opacity-40"
        :disabled="loading || !current"
        @click="choose"
      >
        {{ $t('layout.picker.select') }}
      </button>
    </template>
  </BaseModal>
</template>

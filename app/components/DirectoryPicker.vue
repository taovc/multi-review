<script setup lang="ts">
// Server-side directory picker: browse the file system of the machine running PR Cockpit and pick a
// local git clone directory.
// If the selected directory is a git repo, its origin → owner/repo is filled in along with it.
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
  currentIsGit.value = false // clear the previous directory's git hint first, so a stale owner/repo isn't shown while loading
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

// On open, start from initialPath (the already-filled value) or the last location.
watch(open, (v) => {
  if (v) load(props.initialPath || current.value || undefined)
})

// The path box may hold a hand-typed path that was never submitted with Enter → on "Select", load it
// first to validate, and only save once it is confirmed valid;
// if invalid (404 etc.) stay in the error state instead of treating the previous directory as the
// selection.
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
      <!-- Current path: editable, Enter navigates straight there -->
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

      <!-- Subdirectory list -->
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

      <!-- When the current directory is a git repo, the hint also surfaces owner/repo -->
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

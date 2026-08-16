<script setup lang="ts">
// Automation config dialog.
// Auto-review system: the mode "once after the PR is created / on every push" is multi-select (picking any turns it on, picking none = off, hence no separate enable switch any more) + author/PR-status filters.
// Divider line. Auto-fix system: a switch on the left + author/PR-status filters. There is no "enable the system" master switch at the bottom any more (redundant).
// Author/PR status are inline dropdowns (not teleported to body, so the modal can't cover them and make them unclickable).
const props = defineProps<{ projectId: string; authors: string[] }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ saved: [] }>()
const { t } = useI18n()

const STATUS_OPTS = ['open', 'draft', 'merged', 'closed']
const MODE_OPTS = ['once', 'every_push']
function modeLabel(m: string) { return m === 'every_push' ? t('automation.modeEveryPush') : t('automation.modeOnce') }

// Review mode multi-select: a subset of ['once','every_push']. Empty = auto-review off. every_push includes the first review, so picking every_push automatically brings once along when re-displayed.
const reviewModes = ref<string[]>([])
const reviewAuthors = ref<string[]>([])
const reviewStatuses = ref<string[]>(['open'])
const fixEnabled = ref(false)
const fixAuthors = ref<string[]>([])
const fixStatuses = ref<string[]>(['open'])
const autoMaxRounds = ref(2)

const loading = ref(false)
const saving = ref(false)
const msg = ref('')

async function load() {
  loading.value = true; msg.value = ''
  try {
    const r = await $fetch<any>(`/api/projects/${props.projectId}/automation`)
    reviewModes.value = !r.reviewEnabled ? [] : r.reviewMode === 'every_push' ? ['once', 'every_push'] : ['once']
    reviewAuthors.value = r.reviewAuthors ?? []
    reviewStatuses.value = r.reviewStatuses ?? ['open']
    fixEnabled.value = !!r.fixEnabled
    fixAuthors.value = r.fixAuthors ?? []
    fixStatuses.value = r.fixStatuses ?? ['open']
    autoMaxRounds.value = r.autoMaxRounds ?? 2
  } catch (e: any) {
    msg.value = e?.data?.statusMessage || e?.message || 'load failed'
  } finally {
    loading.value = false
  }
}
watch(open, (v) => { if (v) { openDd.value = null; load() } })

// Toggle a multi-select entry by key (refs are auto-unwrapped in the template, so instead of passing a ref directly we look it up by key)
const lists: Record<string, Ref<string[]>> = { reviewModes, reviewAuthors, reviewStatuses, fixAuthors, fixStatuses }
function toggle(key: string, v: string) {
  const r = lists[key]!
  r.value = r.value.includes(v) ? r.value.filter((x) => x !== v) : [...r.value, v]
}

// Inline dropdowns: only one open at a time, click outside to close
const openDd = ref<string | null>(null)
function toggleDd(id: string) { openDd.value = openDd.value === id ? null : id }
function onDocClick(e: MouseEvent) {
  if (openDd.value && !(e.target as HTMLElement)?.closest?.('.dd-root')) openDd.value = null
}
onMounted(() => document.addEventListener('click', onDocClick))
onBeforeUnmount(() => document.removeEventListener('click', onDocClick))

async function save() {
  saving.value = true; msg.value = ''
  try {
    await $fetch(`/api/projects/${props.projectId}/automation`, {
      method: 'PUT',
      body: {
        masterEnabled: true, // the master switch is folded into each system's own toggle
        reviewEnabled: reviewModes.value.length > 0,
        reviewMode: reviewModes.value.includes('every_push') ? 'every_push' : 'once',
        reviewAuthors: reviewAuthors.value,
        reviewStatuses: reviewStatuses.value,
        fixEnabled: fixEnabled.value,
        fixAuthors: fixAuthors.value,
        fixStatuses: fixStatuses.value,
      },
    })
    emit('saved')
    open.value = false
  } catch (e: any) {
    msg.value = e?.data?.statusMessage || e?.message || 'save failed'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <BaseModal v-model:open="open" :title="$t('automation.title')">
    <div v-if="loading" class="py-10 text-center text-sm text-dimmed">{{ $t('common.loading') }}</div>
    <div v-else class="space-y-5">
      <!-- ── auto-review system ── -->
      <section>
        <div class="text-sm font-medium text-highlighted mb-3">{{ $t('automation.reviewSystem') }}</div>
        <div class="flex items-start gap-2">
          <!-- review mode: multi-select dropdown (once / every push — pick one or both; empty = off) -->
          <div class="dd-root relative flex-1 min-w-0">
            <button class="flex items-center gap-1 px-3 py-1.5 text-sm border border-default rounded hover:bg-muted w-full justify-between" @click="toggleDd('rev-mode')">
              <span class="truncate">{{ $t('automation.modeLabel') }}<span v-if="reviewModes.length" class="ml-1 text-dimmed">({{ reviewModes.length }})</span></span>
              <span class="text-dimmed">▾</span>
            </button>
            <div v-if="openDd === 'rev-mode'" class="absolute top-full left-0 mt-1 z-20 w-48 bg-default border border-default rounded shadow-lg p-2">
              <label v-for="m in MODE_OPTS" :key="m" class="flex items-center gap-2 cursor-pointer text-sm py-1 px-1.5 rounded hover:bg-elevated/50">
                <input type="checkbox" class="accent-neutral-900 dark:accent-neutral-100" :checked="reviewModes.includes(m)" @change="toggle('reviewModes', m)" />
                <span :class="reviewModes.includes(m) ? 'text-highlighted' : 'text-toned'">{{ modeLabel(m) }}</span>
              </label>
            </div>
          </div>
          <!-- author multi-select (inline dropdown) -->
          <div class="dd-root relative flex-1 min-w-0">
            <button class="flex items-center gap-1 px-3 py-1.5 text-sm border border-default rounded hover:bg-muted w-full justify-between" @click="toggleDd('rev-author')">
              <span class="truncate">{{ $t('project.col.author') }}<span v-if="reviewAuthors.length" class="ml-1 text-dimmed">({{ reviewAuthors.length }})</span></span>
              <span class="text-dimmed">▾</span>
            </button>
            <div v-if="openDd === 'rev-author'" class="absolute top-full left-0 mt-1 z-20 w-52 bg-default border border-default rounded shadow-lg p-2 max-h-60 overflow-auto">
              <p v-if="!authors.length" class="text-xs text-dimmed px-1.5 py-1">{{ $t('automation.noAuthors') }}</p>
              <label v-for="a in authors" :key="a" class="flex items-center gap-2 cursor-pointer text-sm py-1 px-1.5 rounded hover:bg-elevated/50">
                <input type="checkbox" class="accent-neutral-900 dark:accent-neutral-100" :checked="reviewAuthors.includes(a)" @change="toggle('reviewAuthors', a)" />
                <span :class="reviewAuthors.includes(a) ? 'text-highlighted' : 'text-toned'">{{ a }}</span>
              </label>
            </div>
          </div>
          <!-- PR status multi-select (inline dropdown) -->
          <div class="dd-root relative flex-1 min-w-0">
            <button class="flex items-center gap-1 px-3 py-1.5 text-sm border border-default rounded hover:bg-muted w-full justify-between" @click="toggleDd('rev-status')">
              <span class="truncate">{{ $t('project.col.prStatus') }}<span v-if="reviewStatuses.length" class="ml-1 text-dimmed">({{ reviewStatuses.length }})</span></span>
              <span class="text-dimmed">▾</span>
            </button>
            <div v-if="openDd === 'rev-status'" class="absolute top-full right-0 mt-1 z-20 w-44 bg-default border border-default rounded shadow-lg p-2">
              <label v-for="s in STATUS_OPTS" :key="s" class="flex items-center gap-2 cursor-pointer text-sm py-1 px-1.5 rounded hover:bg-elevated/50">
                <input type="checkbox" class="accent-neutral-900 dark:accent-neutral-100" :checked="reviewStatuses.includes(s)" @change="toggle('reviewStatuses', s)" />
                <span :class="reviewStatuses.includes(s) ? 'text-highlighted' : 'text-toned'">{{ $t('status.pr.' + s) }}</span>
              </label>
            </div>
          </div>
        </div>
      </section>

      <div class="border-t border-default" />

      <!-- ── auto-fix system ── -->
      <section>
        <div class="flex items-center justify-between gap-3 mb-3">
          <div class="text-sm font-medium text-highlighted">{{ $t('automation.fixSystem') }}</div>
          <USwitch v-model="fixEnabled" />
        </div>
        <div class="flex items-start gap-2" :class="fixEnabled ? '' : 'opacity-50 pointer-events-none'">
          <div class="dd-root relative flex-1 min-w-0">
            <button class="flex items-center gap-1 px-3 py-1.5 text-sm border border-default rounded hover:bg-muted w-full justify-between" @click="toggleDd('fix-author')">
              <span class="truncate">{{ $t('project.col.author') }}<span v-if="fixAuthors.length" class="ml-1 text-dimmed">({{ fixAuthors.length }})</span></span>
              <span class="text-dimmed">▾</span>
            </button>
            <div v-if="openDd === 'fix-author'" class="absolute top-full left-0 mt-1 z-20 w-52 bg-default border border-default rounded shadow-lg p-2 max-h-60 overflow-auto">
              <p v-if="!authors.length" class="text-xs text-dimmed px-1.5 py-1">{{ $t('automation.noAuthors') }}</p>
              <label v-for="a in authors" :key="a" class="flex items-center gap-2 cursor-pointer text-sm py-1 px-1.5 rounded hover:bg-elevated/50">
                <input type="checkbox" class="accent-neutral-900 dark:accent-neutral-100" :checked="fixAuthors.includes(a)" @change="toggle('fixAuthors', a)" />
                <span :class="fixAuthors.includes(a) ? 'text-highlighted' : 'text-toned'">{{ a }}</span>
              </label>
            </div>
          </div>
          <div class="dd-root relative flex-1 min-w-0">
            <button class="flex items-center gap-1 px-3 py-1.5 text-sm border border-default rounded hover:bg-muted w-full justify-between" @click="toggleDd('fix-status')">
              <span class="truncate">{{ $t('project.col.prStatus') }}<span v-if="fixStatuses.length" class="ml-1 text-dimmed">({{ fixStatuses.length }})</span></span>
              <span class="text-dimmed">▾</span>
            </button>
            <div v-if="openDd === 'fix-status'" class="absolute top-full left-0 mt-1 z-20 w-44 bg-default border border-default rounded shadow-lg p-2">
              <label v-for="s in STATUS_OPTS" :key="s" class="flex items-center gap-2 cursor-pointer text-sm py-1 px-1.5 rounded hover:bg-elevated/50">
                <input type="checkbox" class="accent-neutral-900 dark:accent-neutral-100" :checked="fixStatuses.includes(s)" @change="toggle('fixStatuses', s)" />
                <span :class="fixStatuses.includes(s) ? 'text-highlighted' : 'text-toned'">{{ $t('status.pr.' + s) }}</span>
              </label>
            </div>
          </div>
        </div>
        <p class="text-[11px] text-dimmed mt-2">{{ $t('automation.fixHint', { n: autoMaxRounds }) }}</p>
        <p class="text-[11px] text-warning/90 mt-1">{{ $t('automation.fixAuthorHint') }}</p>
      </section>
    </div>

    <template #footer>
      <span class="text-xs text-error mr-auto">{{ msg }}</span>
      <button class="text-sm text-muted hover:text-highlighted px-3" @click="open = false">{{ $t('common.cancel') }}</button>
      <button class="text-sm bg-inverted text-inverted px-4 py-2 hover:bg-inverted/90 disabled:opacity-40" :disabled="saving" @click="save">
        {{ saving ? $t('config.saving') : $t('automation.start') }}
      </button>
    </template>
  </BaseModal>
</template>

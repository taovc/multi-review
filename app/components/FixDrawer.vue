<script setup lang="ts">
import type { Fix } from './fixTypes'

const open = defineModel<boolean>('open', { required: true })
const props = defineProps<{ fixId: string | null }>()
const emit = defineEmits<{ done: [] }>()
const { t, locale } = useI18n()

const fix = ref<Fix | null>(null)
const logLines = ref<string[]>([])
const logBox = ref<HTMLElement>()
const diff = ref<string | null>(null)
const diffTruncated = ref(false)
const busy = ref<'push' | 'discard' | ''>('')
const msg = ref('')
let es: EventSource | null = null

watch(
  logLines,
  () => nextTick(() => { if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight }),
  { deep: true },
)

async function loadFix() {
  if (!props.fixId) return
  fix.value = await $fetch<Fix>(`/api/fixes/${props.fixId}`)
  if (fix.value.status === 'ready' && diff.value === null) loadDiff()
}
async function loadDiff() {
  if (!props.fixId) return
  try {
    const r = await $fetch<{ diff: string; truncated: boolean }>(`/api/fixes/${props.fixId}/diff`)
    diff.value = r.diff
    diffTruncated.value = r.truncated
  } catch {
    /* diff indispo */
  }
}
function openSSE() {
  if (!props.fixId || !import.meta.client) return
  es?.close()
  logLines.value = []
  diff.value = null
  msg.value = ''
  es = new EventSource(`/api/fixes/${props.fixId}/stream`)
  es.onmessage = (ev) => {
    try {
      const e = JSON.parse(ev.data)
      if (e.message) {
        logLines.value.push(`${new Date().toLocaleTimeString(locale.value, { hour12: false })}  ${e.message}`)
        if (logLines.value.length > 300) logLines.value.shift()
      }
      if (['status', 'done', 'error'].includes(e.kind)) loadFix()
    } catch {
      /* ignore */
    }
  }
}
watch(
  () => [open.value, props.fixId] as const,
  ([o]) => {
    if (o && props.fixId) { loadFix(); openSSE() }
    else es?.close()
  },
  { immediate: true },
)
onBeforeUnmount(() => es?.close())

const running = computed(() => ['queued', 'running', 'pushing'].includes(fix.value?.status || ''))
const canPush = computed(() => fix.value?.status === 'ready' && (fix.value?.filesChanged ?? 0) > 0)
const testsOk = computed(() => fix.value?.testsResult === 'passed')

async function push() {
  busy.value = 'push'
  msg.value = ''
  try {
    await $fetch(`/api/fixes/${props.fixId}/push`, { method: 'POST' })
    await loadFix()
    emit('done')
    msg.value = t('fix.result.pushed')
  } catch (e: any) {
    msg.value = e?.data?.statusMessage || t('fix.result.pushFailed')
  } finally {
    busy.value = ''
  }
}
async function discard() {
  busy.value = 'discard'
  try {
    await $fetch(`/api/fixes/${props.fixId}/discard`, { method: 'POST' })
    emit('done')
    open.value = false
  } catch (e: any) {
    msg.value = e?.data?.statusMessage || t('common.failed')
  } finally {
    busy.value = ''
  }
}

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
  hunk: 'text-dimmed px-3',
  add: 'text-success bg-success/10 px-3',
  del: 'text-error bg-error/10 px-3',
  meta: 'text-dimmed px-3',
  ctx: 'text-toned px-3',
}
</script>

<template>
  <USlideover v-model:open="open" :ui="{ content: 'w-[67vw] max-w-none min-w-[640px]' }">
    <template #content>
      <div class="h-full flex flex-col bg-default text-default">
        <!-- header -->
        <div class="px-6 py-5 border-b border-default shrink-0">
          <div class="flex items-center justify-between gap-4">
            <div class="min-w-0">
              <h2 class="text-lg font-medium leading-snug">{{ t('fix.drawer.title') }}<span v-if="fix"> · #{{ fix.prNumber }}</span></h2>
              <p class="text-xs text-dimmed mt-1">
                <span :class="fix?.status === 'error' ? 'text-error' : running ? 'text-toned' : 'text-highlighted'">{{ fix?.status || '—' }}</span>
                <span v-if="fix?.stage"> · {{ fix.stage }}</span>
                <span v-if="fix?.costUsd"> · ${{ fix.costUsd.toFixed(3) }}</span>
              </p>
            </div>
            <span v-if="running" class="inline-block animate-spin text-dimmed">↻</span>
          </div>
        </div>

        <!-- body -->
        <div class="flex-1 overflow-auto px-6 py-5 space-y-5">
          <!-- erreur -->
          <p v-if="fix?.error" class="text-xs text-error whitespace-pre-wrap">{{ fix.error }}</p>

          <!-- journal -->
          <div>
            <p class="text-[10px] uppercase tracking-[0.15em] text-dimmed mb-2">{{ t('fix.drawer.log') }}</p>
            <pre v-if="logLines.length" ref="logBox" class="max-h-56 overflow-auto bg-neutral-900 text-neutral-300 rounded p-2 text-[11px] leading-relaxed font-mono whitespace-pre-wrap">{{ logLines.join('\n') }}</pre>
            <p v-else class="text-xs text-dimmed">{{ running ? t('fix.drawer.starting') : '—' }}</p>
          </div>

          <!-- résultat tests -->
          <div v-if="fix?.testsResult">
            <p class="text-[10px] uppercase tracking-[0.15em] text-dimmed mb-1">{{ t('fix.drawer.tests') }}</p>
            <p class="text-xs" :class="testsOk ? 'text-success' : 'text-error'">{{ testsOk ? t('fix.drawer.testsPassed') : fix.testsResult }}</p>
          </div>

          <!-- diff -->
          <div v-if="diff !== null">
            <p class="text-[10px] uppercase tracking-[0.15em] text-dimmed mb-2">
              {{ t('fix.drawer.diff') }}
              <span v-if="fix" class="text-dimmed">· {{ fix.filesChanged || 0 }} · <span class="text-success">+{{ fix.additions || 0 }}</span> <span class="text-error">−{{ fix.deletions || 0 }}</span></span>
            </p>
            <div v-if="diffLines.length" class="font-mono text-[11px] leading-relaxed overflow-x-auto border border-default rounded">
              <div v-for="(l, i) in diffLines" :key="i" :class="lineCls[l.t]" class="whitespace-pre">{{ l.text || ' ' }}</div>
            </div>
            <p v-else class="text-xs text-dimmed">{{ t('fix.drawer.noChanges') }}</p>
            <p v-if="diffTruncated" class="text-[10px] text-dimmed mt-1">{{ t('fix.drawer.truncated') }}</p>
          </div>
        </div>

        <!-- footer -->
        <div class="px-6 py-4 border-t border-default shrink-0 flex items-center justify-between gap-4">
          <span class="text-xs text-dimmed truncate">{{ msg }}</span>
          <div class="flex gap-2">
            <button
              v-if="fix && ['ready', 'error'].includes(fix.status)"
              class="text-sm text-dimmed hover:text-error px-3 py-1.5 disabled:opacity-40"
              :disabled="!!busy"
              @click="discard"
            >{{ busy === 'discard' ? t('fix.result.discarding') : t('fix.result.discard') }}</button>
            <button
              class="text-sm bg-inverted text-inverted px-4 py-1.5 hover:bg-inverted/90 transition-colors disabled:opacity-40"
              :disabled="!canPush || !!busy"
              @click="push"
            >{{ busy === 'push' ? t('fix.result.pushing') : t('fix.result.push') }}</button>
          </div>
        </div>
      </div>
    </template>
  </USlideover>
</template>

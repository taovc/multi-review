<script setup lang="ts">
// One host event inside the chat stream: a tool call (with its result once it arrives; Edit/Write show the change), a
// thinking block (collapsed), a subagent task, a compaction marker, a denied command or a note. Collapsed by default;
// the summary line is enough to follow along, the details are one click away.
export type StreamEvent = { key: string; kind: string; data: any; result?: any; ts: string; parent?: string | null }
const props = defineProps<{ ev: StreamEvent }>()
const open = ref(false)
const { t } = useI18n()

const summary = computed(() => {
  const d = props.ev.data ?? {}
  switch (props.ev.kind) {
    case 'tool_use': {
      const i = d.input ?? {}
      const v = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.query ?? i.url ?? i.description ?? i.prompt ?? ''
      return `${d.name} ${String(v).slice(0, 140)}`
    }
    case 'thinking': return `${t('global.thinking')} · ${String(d.text ?? '').length}`
    case 'task': return `subagent ${d.status}${d.summary ? `: ${String(d.summary).slice(0, 100)}` : ''}`
    case 'compaction': return t('global.compacted', { pre: d.preTokens, post: d.postTokens ?? '?' })
    case 'permission_denied': return `⛔ ${d.toolName}: ${String(d.message ?? '').slice(0, 140)}`
    case 'note': return String(d.text ?? '').slice(0, 160)
    case 'error': return `✗ ${String(d.message ?? '').slice(0, 160)}`
    default: return props.ev.kind
  }
})
const resultOk = computed(() => (props.ev.result ? !props.ev.result.isError : null))
const isEdit = computed(() => props.ev.kind === 'tool_use' && ['Edit', 'Write', 'MultiEdit', 'ApplyPatch'].includes(String(props.ev.data?.name)))
const cap = (s: unknown, n = 4000) => { const v = typeof s === 'string' ? s : JSON.stringify(s ?? '', null, 1); return v.length > n ? `${v.slice(0, n)}\n… (${v.length - n} more chars)` : v }
const inputText = computed(() => {
  const i = props.ev.data?.input ?? {}
  if (props.ev.data?.name === 'Edit') return `${i.file_path}\n──── old ────\n${cap(i.old_string, 1500)}\n──── new ────\n${cap(i.new_string, 1500)}`
  if (props.ev.data?.name === 'Write') return `${i.file_path}\n────────\n${cap(i.content, 3000)}`
  if (props.ev.data?.name === 'ApplyPatch') return `${i.file_path}\n────────\n${cap(i.diff, 3000)}`
  return cap(i, 2000)
})
const cls = computed(() => props.ev.kind === 'permission_denied' || props.ev.kind === 'error' ? 'border-error/50 text-error' : props.ev.kind === 'compaction' ? 'border-dashed border-default text-dimmed' : props.ev.kind === 'thinking' ? 'border-default text-dimmed italic' : 'border-default text-toned')
</script>

<template>
  <div class="text-[11px] rounded border px-2 py-1" :class="[cls, ev.parent ? 'ml-4' : '']">
    <button class="w-full text-left flex items-center gap-2 hover:text-highlighted" @click="open = !open">
      <span v-if="ev.kind === 'tool_use'" class="shrink-0" :class="resultOk === null ? 'text-dimmed animate-pulse' : resultOk ? 'text-emerald-500' : 'text-error'">{{ resultOk === null ? '◌' : resultOk ? '✓' : '✗' }}</span>
      <span class="font-mono truncate">{{ summary }}</span>
      <span class="ml-auto text-dimmed shrink-0">{{ open ? '▾' : '▸' }}</span>
    </button>
    <div v-if="open" class="mt-1 space-y-1">
      <pre v-if="ev.kind === 'tool_use'" class="max-h-64 overflow-auto bg-neutral-900 text-neutral-300 rounded p-2 leading-relaxed font-mono whitespace-pre-wrap" :class="isEdit ? 'text-[10px]' : ''">{{ inputText }}</pre>
      <pre v-if="ev.kind === 'tool_use' && ev.result" class="max-h-64 overflow-auto rounded p-2 leading-relaxed font-mono whitespace-pre-wrap" :class="ev.result.isError ? 'bg-red-950/40 text-red-200' : 'bg-neutral-900 text-neutral-300'">{{ cap(ev.result.output, 6000) }}</pre>
      <pre v-if="ev.kind === 'thinking'" class="max-h-64 overflow-auto bg-neutral-900 text-neutral-400 rounded p-2 leading-relaxed whitespace-pre-wrap">{{ cap(ev.data?.text, 6000) }}</pre>
      <pre v-if="['note', 'error', 'permission_denied', 'task'].includes(ev.kind)" class="whitespace-pre-wrap">{{ cap(ev.data?.text ?? ev.data?.message ?? ev.data?.description ?? ev.data, 3000) }}</pre>
    </div>
  </div>
</template>

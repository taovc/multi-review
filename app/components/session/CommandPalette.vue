<script setup lang="ts">
// The "/" palette: a prefix-filtered dropdown while typing `/…`, and a grouped browser (local / your skills / plugins /
// built-in / Codex skills) behind the "/" button, with "show all" for the built-ins hidden by default. Selection fills
// `/name ` into the composer; the parent owns the input and the keyboard (↑ ↓ Enter Tab Esc).
import { filterCommands, type CommandEntry } from '~core/host/commands'

const props = defineProps<{
  entries: CommandEntry[] // CLI / Codex entries for this workspace
  local: CommandEntry[] // cockpit-side commands (/clear /cd …)
  head: string | null // text typed after "/" (null = dropdown closed)
  browse: boolean // the grouped browser is open
  highlight: number
}>()
const emit = defineEmits<{ pick: [entry: CommandEntry]; 'update:highlight': [i: number]; close: [] }>()
const { t } = useI18n()
const showAll = ref(false)

const filtered = computed<CommandEntry[]>(() => {
  if (props.head == null) return []
  const h = props.head
  return [...filterCommands(props.local, h, true), ...filterCommands(props.entries, h, showAll.value)]
})
defineExpose({ filtered })

type Group = { key: string; label: string; items: CommandEntry[] }
const groups = computed<Group[]>(() => {
  const all = showAll.value ? props.entries : props.entries.filter((e) => e.curated)
  const g: Group[] = [{ key: 'local', label: t('session.palette.local'), items: props.local }]
  const users = all.filter((e) => e.origin === 'user')
  if (users.length) g.push({ key: 'user', label: t('session.palette.skills'), items: users })
  const codex = all.filter((e) => e.origin === 'codex-skill')
  if (codex.length) g.push({ key: 'codex', label: t('session.palette.codexSkills'), items: codex })
  const plugins = new Map<string, CommandEntry[]>()
  for (const e of all.filter((x) => x.origin === 'plugin')) plugins.set(e.plugin || 'plugin', [...(plugins.get(e.plugin || 'plugin') ?? []), e])
  for (const [name, items] of plugins) g.push({ key: `plugin:${name}`, label: `${t('session.palette.plugin')} · ${name}`, items })
  const builtins = all.filter((e) => e.origin === 'builtin')
  if (builtins.length) g.push({ key: 'builtin', label: t('session.palette.builtin'), items: builtins })
  return g
})
const hiddenCount = computed(() => props.entries.filter((e) => !e.curated).length)
const listEl = ref<HTMLElement | null>(null)
watch(() => props.highlight, (i) => { nextTick(() => listEl.value?.querySelector<HTMLElement>(`[data-i="${i}"]`)?.scrollIntoView({ block: 'nearest' })) })
</script>

<template>
  <!-- Dropdown while typing "/…" -->
  <div v-if="head != null && filtered.length" ref="listEl" class="absolute bottom-full left-0 mb-1 w-full max-h-72 overflow-y-auto bg-default border border-default rounded shadow-lg z-10 text-xs">
    <div
      v-for="(c, i) in filtered" :key="c.name" :data-i="i"
      class="flex items-center gap-3 px-3 py-1.5 cursor-pointer" :class="i === highlight ? 'bg-muted' : 'hover:bg-muted'"
      @mouseenter="emit('update:highlight', i)" @mousedown.prevent="emit('pick', c)"
    >
      <span class="font-mono text-highlighted whitespace-nowrap">/{{ c.name }}<span v-if="c.argumentHint" class="text-dimmed"> {{ c.argumentHint }}</span></span>
      <span class="text-dimmed truncate flex-1">{{ c.description }}</span>
      <span class="text-[10px] uppercase tracking-wider text-dimmed shrink-0">{{ c.origin === 'user' ? $t('session.palette.skill') : c.origin === 'plugin' ? c.plugin : c.origin === 'codex-skill' ? 'codex' : c.origin }}</span>
    </div>
    <div v-if="hiddenCount && !showAll" class="px-3 py-1 text-[10px] text-dimmed border-t border-default">
      <button class="hover:text-highlighted underline" @mousedown.prevent="showAll = true">{{ $t('session.palette.showAll', { n: hiddenCount }) }}</button>
    </div>
  </div>

  <!-- Grouped browser behind the "/" button -->
  <div v-if="browse" class="absolute bottom-full left-0 mb-1 w-full max-h-96 overflow-y-auto bg-default border border-default rounded shadow-lg z-10 text-xs">
    <div class="flex items-center justify-between px-3 py-1.5 border-b border-default text-[10px] uppercase tracking-wider text-dimmed">
      <span>{{ $t('session.palette.title') }}</span>
      <label class="flex items-center gap-1 normal-case tracking-normal cursor-pointer"><input v-model="showAll" type="checkbox" /> {{ $t('session.palette.showAllToggle') }}</label>
      <button class="hover:text-highlighted" @click="emit('close')">✕</button>
    </div>
    <div v-for="g in groups" :key="g.key">
      <div class="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-dimmed">{{ g.label }} ({{ g.items.length }})</div>
      <div v-for="c in g.items" :key="c.name" class="flex items-center gap-3 px-3 py-1 hover:bg-muted cursor-pointer" :title="c.name" @mousedown.prevent="emit('pick', c)">
        <span class="font-mono text-highlighted whitespace-nowrap">/{{ c.shortName }}<span v-if="c.argumentHint" class="text-dimmed"> {{ c.argumentHint }}</span></span>
        <span class="text-dimmed truncate">{{ c.description }}</span>
      </div>
    </div>
  </div>
</template>

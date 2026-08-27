<script setup lang="ts">
// Shared catalogue for whatever a CLI reports as "name + description" (Claude commands and skills, Codex skills):
// grouped sections with counts, a name filter, and rows that show only the first sentence until clicked open — some
// skill descriptions run past 1000 characters and a few Codex skill names past 50, so nothing wraps in the closed row.
const props = defineProps<{
  groups: { key: string; label: string; open?: boolean; items: { id: string; name: string; description: string; meta?: string; detail?: string; muted?: boolean }[] }[]
}>()
const { t } = useI18n()
const filter = ref('')
const opened = ref(new Set<string>())
function toggle(id: string) { const s = new Set(opened.value); if (s.has(id)) s.delete(id); else s.add(id); opened.value = s }
const query = computed(() => filter.value.trim().toLowerCase())
const visible = computed(() => props.groups
  .map((g) => ({ ...g, items: query.value ? g.items.filter((i) => i.name.toLowerCase().includes(query.value)) : g.items }))
  .filter((g) => g.items.length || !query.value))
// The collapsed row shows the first sentence (or the first 160 characters).
function lead(s: string): string {
  const m = s.match(/^[\s\S]{0,160}?[.。!?](?=\s|$)/)
  const l = (m ? m[0] : s).trim()
  return l.length > 160 ? `${l.slice(0, 157)}…` : l
}
</script>

<template>
  <div class="text-xs">
    <UInput v-model="filter" size="xs" color="neutral" variant="outline" icon="i-lucide-search" :placeholder="t('agentConfig.filter')" class="w-56" />
    <details v-for="g in visible" :key="g.key" :open="g.open || !!query" class="mt-2">
      <summary class="cursor-pointer select-none text-dimmed">{{ g.label }} ({{ g.items.length }})</summary>
      <div class="max-h-80 overflow-y-auto mt-1 mb-1 border-t border-default">
        <div v-for="i in g.items" :key="i.id" class="border-b border-default" :class="i.muted ? 'text-dimmed' : ''">
          <button type="button" class="w-full flex items-baseline gap-2 py-1 text-left hover:bg-elevated" @click="toggle(i.id)">
            <span class="font-mono whitespace-nowrap shrink-0">{{ i.name }}</span>
            <span v-if="!opened.has(i.id)" class="text-dimmed truncate min-w-0">{{ lead(i.description) }}</span>
            <span v-if="i.meta" class="ml-auto shrink-0 text-dimmed whitespace-nowrap">{{ i.meta }}</span>
          </button>
          <div v-if="opened.has(i.id)" class="pb-2 pl-3 space-y-1">
            <p class="whitespace-pre-wrap break-words leading-relaxed">{{ i.description || t('agentConfig.noDescription') }}</p>
            <p v-if="i.detail" class="font-mono break-all text-dimmed">{{ i.detail }}</p>
          </div>
        </div>
        <div v-if="!g.items.length" class="text-dimmed py-1">{{ t('agentConfig.none') }}</div>
      </div>
    </details>
    <div v-if="!visible.length" class="text-dimmed mt-2">{{ t('agentConfig.none') }}</div>
  </div>
</template>

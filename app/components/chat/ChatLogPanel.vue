<script setup lang="ts">
// Expandable run-log panel (tool calls / stage progress). The fix/global/feature drawers all use this same one.
defineProps<{ lines: string[] }>()
const open = ref(false)
</script>

<template>
  <div v-if="lines.length" class="shrink-0 text-[11px] text-dimmed mb-2">
    <button class="hover:text-highlighted" @click="open = !open">
      {{ open ? $t('review.collapseLog') : $t('review.expandLog', { count: lines.length }) }}
    </button>
    <pre v-if="open" class="mt-1 max-h-48 overflow-auto bg-neutral-900 text-neutral-300 rounded p-2 leading-relaxed font-mono whitespace-pre-wrap">{{ lines.join('\n') }}</pre>
  </div>
</template>

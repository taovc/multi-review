<script setup lang="ts">
// Mode select · live status · context meter · cost, for a host-backed session (global drawer, fix panel).
import { PERMISSION_MODES, type RunHost } from '../composables/useRunHost'
defineProps<{ host: RunHost; live: boolean; tokens?: { inputTokens: number; outputTokens: number } | null }>()
const fmtTok = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
</script>

<template>
  <label class="flex items-center gap-1.5">
    <span class="text-dimmed">{{ $t('global.modeLabel') }}</span>
    <select :value="host.mode.value" class="border border-default rounded px-1.5 py-0.5 bg-default text-default" @change="host.setMode(($event.target as HTMLSelectElement).value as any)">
      <option v-for="m in PERMISSION_MODES" :key="m" :value="m">{{ $t(`global.mode.${m}`) }}</option>
    </select>
  </label>
  <span v-if="live" class="text-dimmed">
    <span class="inline-block w-1.5 h-1.5 rounded-full mr-1" :class="host.liveStatus.value === 'busy' ? 'bg-inverted animate-pulse' : host.liveStatus.value === 'waiting_prompt' ? 'bg-amber-500' : host.liveStatus.value === 'idle' ? 'bg-emerald-500' : 'bg-neutral-400'" />{{ $t(`global.live.${host.liveStatus.value}`) }}
  </span>
  <span v-if="host.contextUse.value" class="flex items-center gap-1.5 text-dimmed" :title="`${host.contextUse.value.total} / ${host.contextUse.value.max} tokens`">
    <span>{{ $t('global.contextMeter') }}</span>
    <span class="inline-block w-20 h-1.5 rounded bg-muted overflow-hidden"><span class="block h-full bg-inverted" :style="{ width: Math.min(100, host.contextUse.value.pct) + '%' }" /></span>
    <span class="tabular-nums">{{ host.contextUse.value.pct }}%</span>
  </span>
  <span v-if="host.sessionCost.value != null" class="text-dimmed tabular-nums">{{ $t('global.sessionCost') }} ${{ host.sessionCost.value.toFixed(3) }}<span v-if="host.lastTurnCost.value != null"> · {{ $t('global.turnCost') }} ${{ host.lastTurnCost.value.toFixed(3) }}</span></span>
  <span v-if="tokens && (tokens.inputTokens || tokens.outputTokens)" class="text-dimmed tabular-nums">{{ fmtTok(tokens.inputTokens) }} / {{ fmtTok(tokens.outputTokens) }} tok</span>
</template>

<script setup lang="ts">
// Observability dashboard: cost / tokens / precision / recheck / automation over the runs tables. Read-only.
import type { Project } from '~core/db/schema'

const { t, locale } = useI18n()
const { data: projects } = await useFetch<Project[]>('/api/projects')

const projectId = ref<string>('')
const range = ref<'7' | '30' | 'all'>('30')
const from = computed(() => {
  if (range.value === 'all') return ''
  const d = new Date(); d.setDate(d.getDate() - Number(range.value)); return d.toISOString()
})
const { data, pending, refresh } = await useFetch<any>('/api/metrics/overview', {
  query: computed(() => ({ projectId: projectId.value || undefined, from: from.value || undefined })),
  watch: [projectId, from],
})

const totals = computed(() => {
  const rows = data.value?.runsBySubkind ?? []
  const sum = (k: string) => rows.reduce((a: number, r: any) => a + Number(r[k] || 0), 0)
  const priced = rows.some((r: any) => r.cost_usd != null)
  return { runs: sum('runs'), errors: sum('errors'), cost: priced ? sum('cost_usd') : null, unpriced: sum('unpriced'), inTok: sum('input_tokens'), outTok: sum('output_tokens') }
})
const hasData = computed(() => totals.value.runs > 0)

function usd(v: number | null | undefined, digits = 2) { return v == null ? '—' : `$${Number(v).toFixed(digits)}` }
function pct(v: number | null | undefined) { return v == null ? '—' : `${(v * 100).toFixed(0)}%` }
function tok(n: number | null | undefined) { const v = Number(n || 0); return v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : String(v) }
function dur(ms: number | null | undefined) { if (!ms) return '—'; const s = Math.round(ms / 1000); return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s` }
function when(iso: string) { return new Date(iso).toLocaleString(locale.value, { hour12: false }) }
const th = 'text-[10px] uppercase tracking-[0.12em] text-dimmed font-normal text-left py-1.5 pr-4 whitespace-nowrap'
const td = 'py-1.5 pr-4 text-xs whitespace-nowrap'
const num = 'py-1.5 pr-4 text-xs whitespace-nowrap tabular-nums text-right'
</script>

<template>
  <div class="px-6 md:px-8 py-6 max-w-7xl">
    <div class="flex flex-wrap items-end justify-between gap-3 mb-5">
      <div>
        <h1 class="text-xl font-light tracking-tight">{{ $t('dashboard.title') }}</h1>
        <p class="text-xs text-dimmed mt-1">{{ $t('dashboard.subtitle') }}</p>
      </div>
      <div class="flex items-center gap-2 text-xs">
        <select v-model="projectId" class="border border-default rounded px-2 py-1 bg-default text-default">
          <option value="">{{ $t('dashboard.allProjects') }}</option>
          <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option>
        </select>
        <select v-model="range" class="border border-default rounded px-2 py-1 bg-default text-default">
          <option value="7">{{ $t('dashboard.last7') }}</option>
          <option value="30">{{ $t('dashboard.last30') }}</option>
          <option value="all">{{ $t('dashboard.all') }}</option>
        </select>
        <button class="border border-default rounded px-2 py-1 hover:bg-muted disabled:opacity-40" :disabled="pending" @click="refresh()">↻</button>
      </div>
    </div>

    <p v-if="!hasData && !pending" class="text-sm text-dimmed py-10">{{ $t('dashboard.noData') }}</p>

    <template v-else>
      <!-- stat tiles -->
      <div class="grid grid-cols-2 md:grid-cols-4 gap-px bg-default border border-default mb-6">
        <div class="bg-default p-3"><div class="text-[10px] uppercase tracking-[0.15em] text-dimmed">{{ $t('dashboard.runs') }}</div><div class="text-lg tabular-nums">{{ totals.runs }} <span class="text-xs text-dimmed">· {{ totals.errors }} {{ $t('dashboard.errors') }}</span></div></div>
        <div class="bg-default p-3"><div class="text-[10px] uppercase tracking-[0.15em] text-dimmed">{{ $t('dashboard.cost') }}</div><div class="text-lg tabular-nums">{{ usd(totals.cost) }} <span v-if="totals.unpriced" class="text-xs text-dimmed">· {{ $t('dashboard.unpriced', { n: totals.unpriced }) }}</span></div></div>
        <div class="bg-default p-3 col-span-2"><div class="text-[10px] uppercase tracking-[0.15em] text-dimmed">{{ $t('dashboard.tokens') }}</div><div class="text-lg tabular-nums">{{ tok(totals.inTok) }} / {{ tok(totals.outTok) }}</div></div>
      </div>
      <p class="text-[11px] text-dimmed mb-6">
        {{ data?.pricing?.codexModelsPriced ? $t('dashboard.pricingNote', { n: data.pricing.codexModelsPriced, asOf: data.pricing.codexRatesAsOf || '?' }) : $t('dashboard.pricingMissing') }}
      </p>

      <div class="grid grid-cols-1 xl:grid-cols-2 gap-x-10 gap-y-8">
        <!-- by subkind -->
        <section>
          <div class="text-[10px] uppercase tracking-[0.15em] text-dimmed mb-2">{{ $t('dashboard.bySubkind') }}</div>
          <div class="overflow-x-auto"><table class="w-full border-t border-default">
            <thead><tr><th :class="th">{{ $t('dashboard.col.kind') }}</th><th :class="th">{{ $t('dashboard.col.provider') }}</th><th :class="th + ' text-right'">{{ $t('dashboard.col.runs') }}</th><th :class="th + ' text-right'">{{ $t('dashboard.cost') }}</th><th :class="th + ' text-right'">{{ $t('dashboard.tokens') }}</th></tr></thead>
            <tbody><tr v-for="r in data?.runsBySubkind ?? []" :key="r.subkind + r.provider" class="border-t border-default">
              <td :class="td">{{ r.subkind }}</td><td :class="td">{{ r.provider }}</td>
              <td :class="num">{{ r.runs }}<span v-if="r.errors" class="text-dimmed"> ({{ r.errors }} ✗)</span></td>
              <td :class="num">{{ usd(r.cost_usd, 3) }}<span v-if="r.unpriced" class="text-dimmed"> ·{{ r.unpriced }}?</span></td>
              <td :class="num">{{ tok(r.input_tokens) }} / {{ tok(r.output_tokens) }}</td>
            </tr></tbody>
          </table></div>
        </section>

        <!-- by model × effort -->
        <section>
          <div class="text-[10px] uppercase tracking-[0.15em] text-dimmed mb-2">{{ $t('dashboard.byModel') }}</div>
          <div class="overflow-x-auto"><table class="w-full border-t border-default">
            <thead><tr><th :class="th">{{ $t('dashboard.col.model') }}</th><th :class="th">{{ $t('dashboard.col.effort') }}</th><th :class="th + ' text-right'">{{ $t('dashboard.col.runs') }}</th><th :class="th + ' text-right'">{{ $t('dashboard.col.avgCost') }}</th><th :class="th + ' text-right'">{{ $t('dashboard.col.p50Dur') }}</th><th :class="th + ' text-right'">{{ $t('dashboard.col.p95Dur') }}</th></tr></thead>
            <tbody><tr v-for="r in data?.reviewRunsByModel ?? []" :key="r.provider + r.model + r.effort" class="border-t border-default">
              <td :class="td">{{ r.provider }} · {{ r.model || '—' }}</td><td :class="td">{{ r.effort || '—' }}</td>
              <td :class="num">{{ r.runs }}<span v-if="r.errors" class="text-dimmed"> ({{ r.errors }} ✗)</span></td>
              <td :class="num">{{ usd(r.avgCostUsd, 3) }}</td><td :class="num">{{ dur(r.p50DurationMs) }}</td><td :class="num">{{ dur(r.p95DurationMs) }}</td>
            </tr></tbody>
          </table></div>
        </section>

        <!-- precision by skill version -->
        <section class="xl:col-span-2">
          <div class="text-[10px] uppercase tracking-[0.15em] text-dimmed mb-2">{{ $t('dashboard.precision') }}</div>
          <div class="overflow-x-auto"><table class="w-full border-t border-default">
            <thead><tr><th :class="th">{{ $t('dashboard.col.skill') }}</th><th :class="th + ' text-right'">{{ $t('dashboard.col.reviews') }}</th><th :class="th + ' text-right'">{{ $t('dashboard.col.findings') }}</th><th :class="th + ' text-right'">{{ $t('dashboard.col.accepted') }}</th><th :class="th + ' text-right'">{{ $t('dashboard.col.machine') }}</th><th :class="th + ' text-right'">{{ $t('dashboard.col.posted') }}</th><th :class="th + ' text-right'">{{ $t('dashboard.col.precision') }}</th><th :class="th + ' text-right'">{{ $t('dashboard.cost') }}</th><th :class="th + ' text-right'">{{ $t('dashboard.col.costPerAccepted') }}</th></tr></thead>
            <tbody><tr v-for="r in data?.precisionBySkillVersion ?? []" :key="r.skill_version_id || 'default'" class="border-t border-default">
              <td :class="td">{{ r.skill_name ? `${r.skill_name} v${r.version}` : $t('dashboard.defaultSkill') }}</td>
              <td :class="num">{{ r.reviews }}</td><td :class="num">{{ r.findings }}</td><td :class="num">{{ r.human_accepted }}</td><td :class="num">{{ r.machine_checked }}</td><td :class="num">{{ r.posted }}</td>
              <td :class="num">{{ pct(r.precision) }}</td><td :class="num">{{ usd(r.cost_usd, 2) }}</td><td :class="num">{{ usd(r.costPerAccepted, 2) }}</td>
            </tr></tbody>
          </table></div>
        </section>

        <!-- recheck + automation -->
        <section>
          <div class="text-[10px] uppercase tracking-[0.15em] text-dimmed mb-2">{{ $t('dashboard.recheck') }}</div>
          <div class="text-xs space-y-1">
            <div><span class="text-dimmed">{{ $t('dashboard.retractionRate') }}</span> <span class="tabular-nums">{{ pct(data?.recheck?.retractionRate) }}</span> · <span class="text-dimmed">{{ $t('dashboard.fixedRate') }}</span> <span class="tabular-nums">{{ pct(data?.recheck?.fixedRate) }}</span></div>
            <div class="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px]"><span v-for="(n, k) in data?.recheck?.byStatus ?? {}" :key="k">{{ k }} <b>{{ n }}</b></span></div>
          </div>
          <div class="text-[10px] uppercase tracking-[0.15em] text-dimmed mt-5 mb-2">{{ $t('dashboard.automation') }}</div>
          <div class="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px]"><span v-for="(n, k) in data?.automation ?? {}" :key="k">{{ k }} <b>{{ n }}</b></span><span v-if="!Object.keys(data?.automation ?? {}).length" class="text-dimmed">—</span></div>
        </section>

        <!-- by day -->
        <section>
          <div class="text-[10px] uppercase tracking-[0.15em] text-dimmed mb-2">{{ $t('dashboard.byDay') }}</div>
          <div class="overflow-x-auto max-h-64 overflow-y-auto"><table class="w-full border-t border-default">
            <thead><tr><th :class="th">{{ $t('dashboard.col.day') }}</th><th :class="th + ' text-right'">{{ $t('dashboard.col.runs') }}</th><th :class="th + ' text-right'">{{ $t('dashboard.cost') }}</th><th :class="th + ' text-right'">{{ $t('dashboard.tokens') }}</th></tr></thead>
            <tbody><tr v-for="r in data?.costByDay ?? []" :key="r.day" class="border-t border-default">
              <td :class="td">{{ r.day }}</td><td :class="num">{{ r.runs }}</td><td :class="num">{{ usd(r.cost_usd, 2) }}</td><td :class="num">{{ tok(r.input_tokens) }} / {{ tok(r.output_tokens) }}</td>
            </tr></tbody>
          </table></div>
        </section>

        <!-- recent runs -->
        <section class="xl:col-span-2">
          <div class="text-[10px] uppercase tracking-[0.15em] text-dimmed mb-2">{{ $t('dashboard.recent') }}</div>
          <div class="overflow-x-auto"><table class="w-full border-t border-default">
            <thead><tr><th :class="th">{{ $t('dashboard.col.when') }}</th><th :class="th">{{ $t('dashboard.col.project') }}</th><th :class="th">{{ $t('dashboard.col.kind') }}</th><th :class="th">{{ $t('dashboard.col.pr') }}</th><th :class="th">{{ $t('dashboard.col.model') }}</th><th :class="th">{{ $t('dashboard.col.status') }}</th><th :class="th + ' text-right'">{{ $t('dashboard.cost') }}</th><th :class="th + ' text-right'">{{ $t('dashboard.tokens') }}</th><th :class="th + ' text-right'">{{ $t('dashboard.col.duration') }}</th><th :class="th + ' text-right'">{{ $t('dashboard.col.skill') }}</th></tr></thead>
            <tbody><tr v-for="r in data?.recentRuns ?? []" :key="r.id" class="border-t border-default" :title="r.error || r.title || ''">
              <td :class="td">{{ when(r.created_at) }}</td><td :class="td">{{ r.project_name || '—' }}</td><td :class="td">{{ r.subkind }}</td><td :class="td">{{ r.pr_number ? '#' + r.pr_number : '—' }}</td>
              <td :class="td">{{ r.provider }} · {{ r.model || '—' }}<span v-if="r.effort" class="text-dimmed"> · {{ r.effort }}</span></td>
              <td :class="[td, r.status === 'error' ? 'text-error' : '']">{{ r.status }}</td>
              <td :class="num" :title="r.unpriced_turns ? `${r.unpriced_turns} unpriced turn(s) — total is a lower bound` : ''">{{ usd(r.cost_usd, 3) }}<span v-if="r.cost_source === 'estimated'" class="text-dimmed">~</span><span v-if="r.unpriced_turns" class="text-dimmed">+?</span></td>
              <td :class="num">{{ tok(r.input_tokens) }} / {{ tok(r.output_tokens) }}</td><td :class="num">{{ dur(r.duration_ms) }}</td><td :class="num">{{ r.skill_version != null ? 'v' + r.skill_version : '—' }}</td>
            </tr></tbody>
          </table></div>
        </section>
      </div>
    </template>
  </div>
</template>

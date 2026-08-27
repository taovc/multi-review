<script setup lang="ts">
// Agent configuration transparency (global page). Four groups, top to bottom: the two switches PR Cockpit owns, the
// files this directory loads, what Claude Code reports once started (MCP, startup context, commands / skills) and what
// the Codex app-server reports (binary, login, usage window, MCP, skills). Read-only except the switches.
import type { Project } from '~core/db/schema'
import type { AgentConfigReport, ConfigFile } from '~core/host/config'

const { t, locale } = useI18n()
const { data: projects } = await useFetch<Project[]>('/api/projects')
const SERVER = 'server' // select sentinel: an empty-string item value is not allowed by the select primitive
const cwdSel = ref<string>(SERVER)
const projectId = computed(() => (cwdSel.value === SERVER ? '' : cwdSel.value))
const cwdItems = computed(() => [{ label: t('agentConfig.serverCwd'), value: SERVER }, ...(projects.value ?? []).map((p) => ({ label: p.name, value: p.id }))])
const refreshFlag = ref(0)
const { data, pending, error, refresh } = await useFetch<AgentConfigReport>('/api/agent/config', {
  query: computed(() => ({ projectId: projectId.value || undefined, refresh: refreshFlag.value ? '1' : undefined })),
  watch: [projectId],
  lazy: true,
})
async function reprobe() { refreshFlag.value = 1; await refresh(); refreshFlag.value = 0 }

const savedAt = ref('')
const saveError = ref('')
const saving = ref(false)
const chrome = ref(false)
const mcpAllow = ref<string[]>([])
watch(data, (d) => { if (d) { chrome.value = d.agent.chrome; mcpAllow.value = [...d.agent.reviewMcpAllow] } }, { immediate: true })
// The allow list shows what the probe found plus what is already ticked; a ticked server the probe no longer reports
// (removed from the CLI configuration, plugin disabled…) stays visible but is flagged so it can be unticked.
const probedMcp = computed(() => { const p = data.value?.probe; return p && !p.error ? new Set(p.mcp.map((s) => s.name)) : null })
const mcpRows = computed(() => {
  const names = new Set<string>(mcpAllow.value)
  for (const s of data.value?.probe?.mcp ?? []) names.add(s.name)
  return [...names].map((name) => ({ name, stale: !!probedMcp.value && !probedMcp.value.has(name) }))
})
// One save at a time (the controls are disabled meanwhile); a failed save snaps the switches back to what the server holds.
async function save(patch: { chrome?: boolean; reviewMcpAllow?: string[] }) {
  if (saving.value) return
  saving.value = true
  saveError.value = ''
  try {
    const r = await $fetch<{ chrome: boolean; reviewMcpAllow: string[] }>('/api/agent/config', { method: 'PATCH', body: patch })
    chrome.value = r.chrome; mcpAllow.value = [...r.reviewMcpAllow]
    savedAt.value = new Date().toLocaleTimeString(locale.value, { hour12: false })
    if (data.value) data.value = { ...data.value, agent: r }
  } catch (e: any) {
    saveError.value = e?.data?.statusMessage || e?.message || String(e)
    if (data.value) { chrome.value = data.value.agent.chrome; mcpAllow.value = [...data.value.agent.reviewMcpAllow] }
  } finally { saving.value = false }
}
function toggleMcp(name: string, on: boolean) {
  const base = data.value?.agent.reviewMcpAllow ?? mcpAllow.value
  const next = on ? [...new Set([...base, name])] : base.filter(n => n !== name)
  void save({ reviewMcpAllow: next })
}

const kb = (n: number) => n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`
// Explicit locale + hour12 so the server and the browser format identically (hydration).
const at = (iso: string) => new Date(iso).toLocaleString(locale.value, { hour12: false })
const tilde = (p: string) => p.replace(/^\/(?:Users|home)\/[^/]+/, '~')
const SCOPES = ['user', 'project', 'local', 'managed'] as const
const filesByScope = computed(() => SCOPES.map((scope) => ({ scope, files: (data.value?.files ?? []).filter((f: ConfigFile) => f.scope === scope) })).filter((g) => g.files.length))
const contextTotal = computed(() => (data.value?.probe?.context ?? []).reduce((a, c) => a + c.tokens, 0))

// Claude commands: grouped by origin, built-ins closed; plugin rows carry their plugin as meta.
const ORIGINS = ['custom', 'plugin', 'builtin'] as const
const commandGroups = computed(() => ORIGINS.map((origin) => ({
  key: origin, label: t(`agentConfig.cmdOrigin.${origin}`), open: origin !== 'builtin',
  items: (data.value?.probe?.commands ?? []).filter((c) => c.origin === origin).map((c) => ({
    id: c.name, name: `/${c.name}`, description: c.description.replace(/\s*\((user|project)\)\s*$/, ''), // the CLI's origin suffix is already the group
    meta: origin === 'plugin' ? c.name.split(':')[0] : undefined,
    detail: [c.argumentHint && `${t('agentConfig.args')}: ${c.argumentHint}`, c.aliases.length && `${t('agentConfig.aliases')}: ${c.aliases.join(', ')}`].filter(Boolean).join(' · ') || undefined,
  })),
})))
// Codex skills: grouped by the plugin prefix before ":" (standalone skills first); big groups start closed.
const skillGroups = computed(() => {
  const by = new Map<string, { id: string; name: string; description: string; meta: string; detail: string; muted: boolean }[]>()
  for (const s of data.value?.codex?.skills ?? []) {
    const i = s.name.indexOf(':')
    const key = i > 0 ? s.name.slice(0, i) : ''
    const list = by.get(key) ?? []
    list.push({ id: s.path || s.name, name: i > 0 ? s.name.slice(i + 1) : s.name, description: s.description, meta: s.enabled ? s.scope : `${s.scope} · ${t('agentConfig.disabled')}`, detail: `/${s.name} · ${tilde(s.path)}`, muted: !s.enabled })
    by.set(key, list)
  }
  return [...by.entries()]
    .sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
    .map(([key, items]) => ({ key: key || '_', label: key || t('agentConfig.skillGroupLocal'), open: !key || items.length <= 10, items })) // standalone skills are the user's own: always open
})
const disabledSkills = computed(() => (data.value?.codex?.skills ?? []).filter((s) => !s.enabled).length)

const th = 'text-left font-normal text-dimmed px-2 py-1 whitespace-nowrap text-[10px] uppercase tracking-[0.12em]'
const td = 'px-2 py-1 align-top'
const box = 'border border-default'
const head = 'px-4 py-3 border-b border-default'
const h2 = 'text-sm text-highlighted'
const hint = 'text-xs text-dimmed mt-0.5 leading-relaxed'
const h3 = 'text-[10px] uppercase tracking-[0.15em] text-dimmed'
const sub = 'text-[11px] text-dimmed leading-relaxed mt-0.5 mb-2'
const card = 'border border-default p-3'
</script>

<template>
  <div class="max-w-6xl mx-auto px-6 py-6 space-y-6">
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="text-lg text-highlighted">{{ t('agentConfig.title') }}</h1>
        <p class="text-xs text-dimmed mt-1 max-w-2xl">{{ t('agentConfig.subtitle') }}</p>
      </div>
      <div class="flex items-center gap-2 text-xs">
        <span class="text-dimmed">{{ t('agentConfig.cwd') }}</span>
        <USelect v-model="cwdSel" :items="cwdItems" size="sm" color="neutral" variant="outline" class="w-44" />
        <UButton variant="outline" color="neutral" size="sm" icon="i-lucide-refresh-cw" :loading="pending" @click="reprobe">{{ pending ? t('agentConfig.probing') : t('agentConfig.refreshProbe') }}</UButton>
      </div>
    </div>

    <p v-if="error" class="text-sm text-highlighted border border-default p-3">{{ (error as any)?.data?.statusMessage || (error as any)?.statusMessage || error.message }}</p>
    <div v-if="data" class="text-xs text-dimmed font-mono break-all">
      {{ data.cwd }} · {{ t('agentConfig.memoryDir') }}: ~/.claude/projects/{{ data.projectDirName }}
    </div>

    <!-- 1. the switches PR Cockpit owns -->
    <section v-if="data" :class="box">
      <div :class="head">
        <h2 :class="h2">{{ t('agentConfig.groups.switches') }} <span v-if="savedAt" class="text-xs text-dimmed">· {{ t('agentConfig.saved') }} {{ savedAt }}</span><span v-if="saveError" class="text-xs text-highlighted"> · {{ saveError }}</span></h2>
        <p :class="hint">{{ t('agentConfig.groups.switchesHint') }}</p>
      </div>
      <div class="p-4 grid md:grid-cols-2 gap-4">
        <div :class="card">
          <div :class="h3">{{ t('agentConfig.sessionSwitch') }}</div>
          <div class="flex items-start justify-between gap-4 mt-2">
            <div class="text-sm">{{ t('agentConfig.chrome') }}<span class="block text-xs text-dimmed mt-0.5 leading-relaxed">{{ t('agentConfig.chromeHint') }}</span></div>
            <USwitch :model-value="chrome" :disabled="saving" @update:model-value="(v: boolean) => save({ chrome: v })" />
          </div>
        </div>
        <div :class="card">
          <div :class="h3">{{ t('agentConfig.reviewSwitch') }}</div>
          <div class="text-sm mt-2">{{ t('agentConfig.mcpAllow') }}<span class="block text-xs text-dimmed mt-0.5 leading-relaxed">{{ t('agentConfig.mcpAllowHint') }}</span></div>
          <div class="flex flex-wrap gap-x-4 gap-y-2 mt-3">
            <UCheckbox v-for="r in mcpRows" :key="r.name" :model-value="mcpAllow.includes(r.name)" :disabled="saving" :label="r.name" :description="r.stale ? t('agentConfig.probeMissing') : undefined" :ui="{ label: 'font-mono text-xs', description: 'text-[11px]' }" @update:model-value="(v) => toggleMcp(r.name, v === true)" />
            <span v-if="!mcpRows.length" class="text-xs text-dimmed">{{ t('agentConfig.none') }}</span>
          </div>
        </div>
      </div>
    </section>

    <!-- 2. what this directory loads -->
    <section v-if="data" :class="box">
      <div :class="head"><h2 :class="h2">{{ t('agentConfig.groups.sources') }}</h2><p :class="hint">{{ t('agentConfig.groups.sourcesHint') }}</p></div>
      <div class="p-4 overflow-x-auto">
        <table class="text-xs w-full">
          <thead><tr><th :class="th">{{ t('agentConfig.kind') }}</th><th :class="th">{{ t('agentConfig.path') }}</th><th :class="th">{{ t('agentConfig.size') }}</th><th :class="th">{{ t('agentConfig.count') }}</th></tr></thead>
          <tbody v-for="g in filesByScope" :key="g.scope">
            <tr class="border-t border-default"><td colspan="4" :class="[td, 'pt-2 text-[10px] uppercase tracking-[0.12em] text-dimmed']">{{ t(`agentConfig.scopeLabel.${g.scope}`) }}</td></tr>
            <tr v-for="f in g.files" :key="f.path" class="border-t border-default" :class="f.exists ? '' : 'text-dimmed'">
              <td :class="[td, 'whitespace-nowrap']">{{ f.kind }}</td><td :class="[td, 'font-mono break-all']">{{ f.path }}</td>
              <td :class="[td, 'whitespace-nowrap']">{{ f.exists ? kb(f.bytes) : t('agentConfig.missing') }}</td><td :class="td">{{ f.count ?? '' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- 3. what Claude Code reports once started -->
    <section v-if="data" :class="box">
      <div :class="head">
        <h2 :class="h2">{{ t('agentConfig.groups.claude') }} <span class="text-xs text-dimmed">· <template v-if="data.probe">{{ t('agentConfig.probeTime', { at: at(data.probe.at), ms: data.probe.ms }) }}</template><template v-else>{{ t('agentConfig.noProbe') }}</template></span></h2>
        <p :class="hint">{{ t('agentConfig.groups.claudeHint') }}</p>
      </div>
      <div class="p-4 space-y-4">
        <p v-if="data.probe?.error" class="text-xs text-highlighted">{{ t('agentConfig.probeError', { msg: data.probe.error }) }}</p>
        <div v-if="data.probe" class="grid md:grid-cols-2 gap-4 text-xs">
          <div :class="card">
            <div :class="h3">{{ t('agentConfig.mcp') }} ({{ data.probe.mcp.length }})</div><p :class="sub">{{ t('agentConfig.mcpHint') }}</p>
            <div v-for="s in data.probe.mcp" :key="s.name" class="font-mono">{{ s.name }} · <span :class="s.status === 'connected' ? 'text-highlighted' : ''">{{ s.status }}</span><span v-if="s.version" class="text-dimmed"> · {{ s.version }}</span></div>
            <div v-if="!data.probe.mcp.length">{{ t('agentConfig.none') }}</div>
          </div>
          <div :class="card">
            <div :class="h3">{{ t('agentConfig.context') }} · {{ contextTotal.toLocaleString() }} {{ t('agentConfig.tokens') }}</div><p :class="sub">{{ t('agentConfig.contextHint') }}</p>
            <div v-for="c in data.probe.context" :key="c.name" class="flex justify-between gap-3 font-mono"><span>{{ c.name }}<span v-if="c.deferred" class="text-dimmed"> ({{ t('agentConfig.deferred') }})</span></span><span class="tabular-nums">{{ c.tokens.toLocaleString() }}</span></div>
          </div>
          <div :class="[card, 'md:col-span-2']">
            <div :class="h3">{{ t('agentConfig.commands') }} ({{ data.probe.commands.length }})</div><p :class="sub">{{ t('agentConfig.commandsHint') }}</p>
            <CatalogList :groups="commandGroups" />
          </div>
        </div>
      </div>
    </section>

    <!-- 4. what the Codex app-server reports -->
    <section v-if="data" :class="box">
      <div :class="head">
        <h2 :class="h2">{{ t('agentConfig.groups.codex') }} <span v-if="data.codex" class="text-xs text-dimmed">· {{ data.codex.version || '?' }} · {{ data.codex.ms }} ms</span></h2>
        <p :class="hint">{{ t('agentConfig.groups.codexHint') }}</p>
      </div>
      <div class="p-4 space-y-4">
        <p v-if="data.codex?.error" class="text-xs text-highlighted">{{ t('agentConfig.codexError', { msg: data.codex.error }) }}</p>
        <div v-if="data.codex" class="grid md:grid-cols-3 gap-4 text-xs">
          <div :class="card">
            <div :class="h3">{{ t('agentConfig.codexBin') }} · {{ t('agentConfig.codexAuth') }}</div>
            <div class="font-mono mt-2">{{ data.codex.version || '?' }} <span class="text-dimmed">· {{ data.codex.binSource || '?' }}</span></div>
            <details class="mt-1"><summary class="cursor-pointer text-dimmed">{{ t('agentConfig.codexPath') }}</summary><div class="font-mono break-all text-dimmed mt-1">{{ data.codex.bin || '—' }}</div></details>
            <div class="text-dimmed mt-2">{{ t('agentConfig.codexAuth') }}</div>
            <div>{{ data.codex.auth.method || t('agentConfig.none') }}</div>
          </div>
          <div :class="card">
            <div :class="h3">{{ t('agentConfig.codexRateLimits') }}<span v-if="data.codex.rateLimits?.plan"> · {{ data.codex.rateLimits.plan }}</span></div><p :class="sub">{{ t('agentConfig.codexRateHint') }}</p>
            <template v-if="data.codex.rateLimits">
              <div v-for="(w, k) in { primary: data.codex.rateLimits.primary, secondary: data.codex.rateLimits.secondary }" :key="k" class="font-mono"><template v-if="w">{{ k }} · {{ w.usedPercent }}% of {{ Math.round(w.windowMinutes / 60) }}h<span v-if="w.resetsAt" class="text-dimmed"> · resets {{ at(w.resetsAt) }}</span></template></div>
            </template>
            <div v-else>{{ t('agentConfig.none') }}</div>
          </div>
          <div :class="card">
            <div :class="h3">{{ t('agentConfig.mcp') }} ({{ data.codex.mcpServers.length }})</div><p :class="sub">{{ t('agentConfig.codexMcpHint') }}</p>
            <div v-for="s in data.codex.mcpServers" :key="s.name" class="font-mono">{{ s.name }} · {{ s.authStatus }} · {{ s.tools }} tools</div>
            <div v-if="!data.codex.mcpServers.length">{{ t('agentConfig.none') }}</div>
          </div>
          <div :class="[card, 'md:col-span-3']">
            <div :class="h3">{{ t('agentConfig.codexSkills') }} ({{ data.codex.skills.length }})<span v-if="disabledSkills"> · {{ disabledSkills }} {{ t('agentConfig.disabled') }}</span></div><p :class="sub">{{ t('agentConfig.codexSkillsHint') }}</p>
            <CatalogList :groups="skillGroups" />
          </div>
        </div>
        <div v-else class="text-xs text-dimmed">{{ t('agentConfig.noProbe') }}</div>
      </div>
    </section>
  </div>
</template>

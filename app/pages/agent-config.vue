<script setup lang="ts">
// Agent configuration transparency (global page): loaded files, effective settings with provenance, what the CLI reports
// once started, per-run-kind overrides, and the two global switches. Read-only except the switches.
import type { Project } from '~core/db/schema'
import type { AgentConfigReport } from '~core/host/config'

const { t } = useI18n()
const { data: projects } = await useFetch<Project[]>('/api/projects')
const projectId = ref<string>('')
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
const mcpNames = computed(() => {
  const names = new Set<string>(mcpAllow.value)
  for (const s of data.value?.probe?.mcp ?? []) names.add(s.name)
  return [...names]
})
// One save at a time (the checkboxes are disabled meanwhile); a failed save snaps the switches back to what the server holds.
async function save(patch: { chrome?: boolean; reviewMcpAllow?: string[] }) {
  if (saving.value) return
  saving.value = true
  saveError.value = ''
  try {
    const r = await $fetch<{ chrome: boolean; reviewMcpAllow: string[] }>('/api/agent/config', { method: 'PATCH', body: patch })
    chrome.value = r.chrome; mcpAllow.value = [...r.reviewMcpAllow]
    savedAt.value = new Date().toLocaleTimeString()
    if (data.value) data.value = { ...data.value, agent: r }
    await refresh() // the per-run-kind table depends on the switches (probe stays cached)
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
const th = 'text-left font-normal text-dimmed px-2 py-1 whitespace-nowrap'
const td = 'px-2 py-1 align-top'
const box = 'border border-default p-4'
const h2 = 'text-xs uppercase tracking-[0.12em] text-dimmed mb-3'
const sections = computed(() => {
  const s = data.value?.settings
  if (!s) return []
  return [
    { key: 'allow', rows: s.allow }, { key: 'deny', rows: s.deny }, { key: 'ask', rows: s.ask },
    { key: 'plugins', rows: s.enabledPlugins }, { key: 'envKeys', rows: s.envKeys }, { key: 'otherKeys', rows: s.otherKeys },
  ]
})
const contextTotal = computed(() => (data.value?.probe?.context ?? []).reduce((a, c) => a + c.tokens, 0))
</script>

<template>
  <div class="max-w-6xl mx-auto px-6 py-6 space-y-6">
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="text-lg text-highlighted">{{ t('agentConfig.title') }}</h1>
        <p class="text-xs text-dimmed mt-1 max-w-2xl">{{ t('agentConfig.subtitle') }}</p>
      </div>
      <div class="flex items-center gap-3 text-xs">
        <label class="flex items-center gap-2">
          <span class="text-dimmed">{{ t('agentConfig.cwd') }}</span>
          <select v-model="projectId" class="border border-default bg-transparent px-2 py-1 outline-none">
            <option value="">{{ t('agentConfig.serverCwd') }}</option>
            <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
        </label>
        <button class="border border-default px-3 py-1 hover:border-inverted disabled:opacity-40" :disabled="pending" @click="reprobe">{{ pending ? t('agentConfig.probing') : t('agentConfig.refreshProbe') }}</button>
      </div>
    </div>

    <p v-if="error" class="text-sm text-highlighted border border-default p-3">{{ (error as any)?.data?.statusMessage || (error as any)?.statusMessage || error.message }}</p>
    <div v-if="data" class="text-xs text-dimmed font-mono break-all">
      {{ data.cwd }} · {{ t('agentConfig.memoryDir') }}: ~/.claude/projects/{{ data.projectDirName }}
    </div>

    <!-- switches -->
    <section v-if="data" :class="box">
      <h2 :class="h2">{{ t('agentConfig.switches') }} <span v-if="savedAt" class="normal-case tracking-normal text-dimmed">· {{ t('agentConfig.saved') }} {{ savedAt }}</span><span v-if="saveError" class="normal-case tracking-normal text-highlighted"> · {{ saveError }}</span></h2>
      <label class="flex items-start gap-2 text-sm">
        <input type="checkbox" class="mt-1" :checked="chrome" :disabled="saving" @change="save({ chrome: ($event.target as HTMLInputElement).checked })" />
        <span>{{ t('agentConfig.chrome') }}<span class="block text-xs text-dimmed">{{ t('agentConfig.chromeHint') }}</span></span>
      </label>
      <div class="mt-3 text-sm">
        <div>{{ t('agentConfig.mcpAllow') }}<span class="block text-xs text-dimmed">{{ t('agentConfig.mcpAllowHint') }}</span></div>
        <div class="flex flex-wrap gap-3 mt-2">
          <label v-for="n in mcpNames" :key="n" class="flex items-center gap-1 text-xs font-mono">
            <input type="checkbox" :checked="mcpAllow.includes(n)" :disabled="saving" @change="toggleMcp(n, ($event.target as HTMLInputElement).checked)" /> {{ n }}
          </label>
          <span v-if="!mcpNames.length" class="text-xs text-dimmed">{{ t('agentConfig.none') }}</span>
        </div>
      </div>
    </section>

    <!-- per run kind -->
    <section v-if="data" :class="box">
      <h2 :class="h2">{{ t('agentConfig.overrides') }}</h2>
      <div class="overflow-x-auto">
        <table class="text-xs w-full">
          <thead><tr>
            <th :class="th">{{ t('agentConfig.runKind') }}</th><th :class="th">{{ t('agentConfig.settingSources') }}</th><th :class="th">{{ t('agentConfig.systemPrompt') }}</th>
            <th :class="th">{{ t('agentConfig.permissionMode') }}</th><th :class="th">{{ t('agentConfig.hooks') }}</th><th :class="th">MCP</th><th :class="th">{{ t('agentConfig.toolsCol') }}</th>
          </tr></thead>
          <tbody>
            <tr v-for="o in data.overrides" :key="o.kind" class="border-t border-default">
              <td :class="[td, 'font-medium text-highlighted']">{{ o.kind }}</td><td :class="td">{{ o.settingSources }}</td><td :class="td">{{ o.systemPrompt }}</td>
              <td :class="td">{{ o.permissionMode }}</td><td :class="td">{{ o.hooks }}</td><td :class="td">{{ o.mcp }}</td>
              <td :class="td">{{ o.tools }}<details v-if="o.denyRules.length" class="mt-1"><summary class="cursor-pointer text-dimmed">{{ t('agentConfig.denyRules') }} ({{ o.denyRules.length }})</summary><div class="font-mono text-dimmed mt-1 space-y-px"><div v-for="r in o.denyRules" :key="r">{{ r }}</div></div></details></td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- files -->
    <section v-if="data" :class="box">
      <h2 :class="h2">{{ t('agentConfig.files') }}</h2>
      <div class="overflow-x-auto">
        <table class="text-xs w-full">
          <thead><tr><th :class="th">{{ t('agentConfig.kind') }}</th><th :class="th">{{ t('agentConfig.scope') }}</th><th :class="th">{{ t('agentConfig.path') }}</th><th :class="th">{{ t('agentConfig.size') }}</th><th :class="th">{{ t('agentConfig.count') }}</th></tr></thead>
          <tbody>
            <tr v-for="f in data.files" :key="f.path" class="border-t border-default" :class="f.exists ? '' : 'text-dimmed'">
              <td :class="td">{{ f.kind }}</td><td :class="td">{{ f.scope }}</td><td :class="[td, 'font-mono break-all']">{{ f.path }}</td>
              <td :class="[td, 'whitespace-nowrap']">{{ f.exists ? kb(f.bytes) : t('agentConfig.missing') }}</td><td :class="td">{{ f.count ?? '' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- effective settings -->
    <section v-if="data" :class="box">
      <h2 :class="h2">{{ t('agentConfig.settings') }}</h2>
      <div class="grid md:grid-cols-2 gap-4 text-xs">
        <div>
          <div class="text-dimmed">{{ t('agentConfig.defaultMode') }}</div>
          <div>{{ data.settings.defaultMode ? `${data.settings.defaultMode.value} (${data.settings.defaultMode.source})` : t('agentConfig.none') }}</div>
          <div class="text-dimmed mt-2">{{ t('agentConfig.model') }}</div>
          <div>{{ data.settings.model ? `${data.settings.model.value} (${data.settings.model.source})` : t('agentConfig.none') }}</div>
          <div class="text-dimmed mt-2">{{ t('agentConfig.hooks') }}</div>
          <div v-if="!data.settings.hooks.length">{{ t('agentConfig.none') }}</div>
          <div v-for="(h, i) in data.settings.hooks" :key="i" class="font-mono">{{ h.event }} · {{ h.matcher }} · {{ h.count }} <span class="text-dimmed">({{ h.source }})</span></div>
        </div>
        <div v-for="s in sections" :key="s.key">
          <div class="text-dimmed">{{ t(`agentConfig.${s.key}`) }} ({{ s.rows.length }})</div>
          <div v-if="!s.rows.length">{{ t('agentConfig.none') }}</div>
          <div v-for="(r, i) in s.rows" :key="i" class="font-mono break-all">{{ r.value }} <span class="text-dimmed">({{ r.source }})</span></div>
        </div>
      </div>
    </section>

    <!-- CLI report -->
    <section v-if="data" :class="box">
      <h2 :class="h2">{{ t('agentConfig.cli') }}
        <span class="normal-case tracking-normal">· <template v-if="data.probe">{{ t('agentConfig.probeTime', { at: new Date(data.probe.at).toLocaleTimeString(), ms: data.probe.ms }) }}</template><template v-else>{{ t('agentConfig.noProbe') }}</template></span>
      </h2>
      <p v-if="data.probe?.error" class="text-xs text-highlighted mb-3">{{ t('agentConfig.probeError', { msg: data.probe.error }) }}</p>
      <div v-if="data.probe" class="grid md:grid-cols-2 gap-4 text-xs">
        <div>
          <div class="text-dimmed">{{ t('agentConfig.account') }}</div>
          <div>{{ data.probe.account.subscriptionType || '—' }} · {{ data.probe.account.apiProvider || '—' }}<template v-if="data.probe.account.organization"> · {{ data.probe.account.organization }}</template></div>
          <div class="text-dimmed mt-2">{{ t('agentConfig.mcp') }} ({{ data.probe.mcp.length }})</div>
          <div v-for="s in data.probe.mcp" :key="s.name" class="font-mono">{{ s.name }} · <span :class="s.status === 'connected' ? 'text-highlighted' : ''">{{ s.status }}</span><span v-if="s.version" class="text-dimmed"> · {{ s.version }}</span></div>
          <div class="text-dimmed mt-2">{{ t('agentConfig.context') }} · {{ contextTotal.toLocaleString() }} {{ t('agentConfig.tokens') }}</div>
          <div v-for="c in data.probe.context" :key="c.name" class="flex justify-between gap-3 font-mono"><span>{{ c.name }}<span v-if="c.deferred" class="text-dimmed"> ({{ t('agentConfig.deferred') }})</span></span><span>{{ c.tokens.toLocaleString() }}</span></div>
          <div class="text-dimmed mt-2">{{ t('agentConfig.models') }} ({{ data.probe.models.length }})</div>
          <div v-for="m in data.probe.models" :key="m.value" class="font-mono">{{ m.value }} <span class="text-dimmed">{{ m.displayName }}</span></div>
          <div class="text-dimmed mt-2">{{ t('agentConfig.agents') }} ({{ data.probe.agents.length }})</div>
          <div v-for="a in data.probe.agents" :key="a.name" class="font-mono">{{ a.name }}<span v-if="a.model" class="text-dimmed"> · {{ a.model }}</span></div>
        </div>
        <div>
          <div class="text-dimmed">{{ t('agentConfig.commands') }} ({{ data.probe.commands.length }})</div>
          <div class="max-h-[32rem] overflow-y-auto">
            <div v-for="c in data.probe.commands" :key="c.name" class="flex gap-2"><span class="font-mono whitespace-nowrap">/{{ c.name }}</span><span class="text-dimmed truncate" :title="c.description">{{ c.description }}</span></div>
          </div>
        </div>
      </div>
    </section>

    <!-- Codex (app-server) -->
    <section v-if="data" :class="box">
      <h2 :class="h2">{{ t('agentConfig.codex') }}
        <span v-if="data.codex" class="normal-case tracking-normal">· {{ data.codex.version || '?' }} · {{ data.codex.ms }} ms</span>
      </h2>
      <p v-if="data.codex?.error" class="text-xs text-highlighted mb-3">{{ t('agentConfig.codexError', { msg: data.codex.error }) }}</p>
      <div v-if="data.codex" class="grid md:grid-cols-2 gap-4 text-xs">
        <div>
          <div class="text-dimmed">{{ t('agentConfig.codexBin') }}</div>
          <div class="font-mono break-all">{{ data.codex.bin || '—' }} <span class="text-dimmed">({{ data.codex.binSource || '?' }})</span></div>
          <div class="text-dimmed mt-2">{{ t('agentConfig.codexAuth') }}</div>
          <div>{{ data.codex.auth.method || t('agentConfig.none') }}</div>
          <div class="text-dimmed mt-2">{{ t('agentConfig.mcp') }} ({{ data.codex.mcpServers.length }})</div>
          <div v-for="s in data.codex.mcpServers" :key="s.name" class="font-mono">{{ s.name }} · {{ s.authStatus }} · {{ s.tools }} tools</div>
          <div class="text-dimmed mt-2">{{ t('agentConfig.models') }} ({{ data.codex.models.length }})</div>
          <div v-for="m in data.codex.models" :key="m.id" class="font-mono">{{ m.id }} <span class="text-dimmed">{{ m.efforts.join('/') }}</span></div>
        </div>
        <div>
          <div class="text-dimmed">{{ t('agentConfig.codexConfig') }}</div>
          <div v-for="(v, k) in data.codex.config" :key="k" class="flex gap-2 font-mono"><span class="whitespace-nowrap">{{ k }}</span><span class="text-dimmed truncate">{{ typeof v === 'object' ? JSON.stringify(v) : v }}<template v-if="data.codex.configOrigins[k]"> ({{ data.codex.configOrigins[k] }})</template></span></div>
          <div class="text-dimmed mt-2">{{ t('agentConfig.codexSkills') }} ({{ data.codex.skills.length }})</div>
          <div v-for="s in data.codex.skills" :key="s.path" class="font-mono" :class="s.enabled ? '' : 'text-dimmed'">{{ s.name }} <span class="text-dimmed">· {{ s.scope }}</span></div>
        </div>
      </div>
      <div v-else class="text-xs text-dimmed">{{ t('agentConfig.noProbe') }}</div>
    </section>
  </div>
</template>

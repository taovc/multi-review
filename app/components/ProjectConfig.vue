<script setup lang="ts">
import type { Project, Skill } from '~core/db/schema'
const props = defineProps<{ project: Project }>()
const emit = defineEmits<{ changed: []; deleted: [] }>()
const { t } = useI18n()

type ModelCap = { value: string; displayName: string; description: string; supportsEffort: boolean; effortLevels: string[] }
type Provider = 'claude' | 'codex'
type ProviderStageId = 'review' | 'fix_chat' | 'recheck' | 'skill_generation' | 'publish_reply'
type ProviderCapabilityStage = { id: ProviderStageId; claude: boolean; codex: boolean; providerControlled: boolean }
type CodexSdkStatus = { installed: boolean; authStatus: 'authenticated' | 'missing' | 'unknown'; detail: string; sdkVersion?: string }
type AgentCapabilities = {
  models: ModelCap[]
  providers?: { stages: ProviderCapabilityStage[] }
  codex?: CodexSdkStatus
  codexModels?: ModelCap[] // 从 `codex debug models` 动态拉取的当前账号真实可用模型
  error?: string // 实时读本地 claude 失败时由后端带回（用于 Claude 状态卡）
}
const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh'] // 选「全局默认」时的兜底档

// 表单（项目信息 + 模型）
const form = reactive({
  name: props.project.name,
  repo: props.project.repo,
  localPath: props.project.localPath || '',
  defaultBranch: props.project.defaultBranch,
  provider: ((props.project as Project & { provider?: Provider }).provider || 'claude') as Provider,
  model: props.project.model || '',
  effort: props.project.effort || '',
  autoMaxRounds: (props.project as Project & { autoMaxRounds?: number }).autoMaxRounds ?? 2,
  autoCooldownMinutes: (props.project as Project & { autoCooldownMinutes?: number }).autoCooldownMinutes ?? 5,
})
const savingInfo = ref(false)
const msg = ref('')

const { data: caps, pending: capsPending } = useFetch<AgentCapabilities>('/api/agent/capabilities')
const modelOptions = computed<ModelCap[]>(() => [
  { value: '', displayName: t('config.globalDefault'), description: t('config.useEnvDefault'), supportsEffort: false, effortLevels: [] },
  ...(caps.value?.models ?? []),
])
const capabilityStages = computed(() => caps.value?.providers?.stages ?? [])
const codexStatus = computed<CodexSdkStatus | null>(() => caps.value?.codex ?? null)
// Claude 状态：本地 claude 能列出模型且无 error = 可用（与 Codex 状态卡对称展示）。
const claudeStatus = computed(() => {
  const modelCount = caps.value?.models?.length ?? 0
  const ready = !caps.value?.error && modelCount > 0
  const detail = caps.value?.error
    ? caps.value.error
    : ready ? t('config.claudeStatusReady', { n: modelCount }) : ''
  return { ready, modelCount, detail }
})
const selectedProviderLabel = computed(() => form.provider === 'codex' ? t('config.providerCodex') : t('config.providerClaude'))
// 统一的模型列表：claude 用本地真实可用模型；codex 用 `codex debug models` 动态拉取的真实模型。都带「全局默认」。
const codexModelOptions = computed<ModelCap[]>(() => [
  { value: '', displayName: t('config.globalDefault'), description: t('config.codexModelPlaceholder'), supportsEffort: false, effortLevels: [] },
  ...(caps.value?.codexModels ?? []),
])
const activeModelOptions = computed<ModelCap[]>(() => form.provider === 'codex' ? codexModelOptions.value : modelOptions.value)
const effortOptions = computed(() => {
  const list = form.provider === 'codex' ? (caps.value?.codexModels ?? []) : (caps.value?.models ?? [])
  const m = list.find((x) => x.value === form.model)
  if (m) return m.supportsEffort ? m.effortLevels : []
  // 选了「全局默认」（没具体模型）：codex 给通用兜底档，claude 不显示
  return form.provider === 'codex' ? CODEX_EFFORTS : []
})
watch(() => form.model, () => { if (!effortOptions.value.includes(form.effort)) form.effort = '' })
watch(() => form.provider, () => {
  form.model = ''
  form.effort = ''
})

async function saveInfo() {
  savingInfo.value = true; msg.value = ''
  try {
    await $fetch(`/api/projects/${props.project.id}`, {
      method: 'PATCH',
      body: {
        name: form.name, repo: form.repo, localPath: form.localPath || null,
        defaultBranch: form.defaultBranch, provider: form.provider, model: form.model || null, effort: form.effort || null,
        autoMaxRounds: Math.min(10, Math.max(1, Number(form.autoMaxRounds) || 2)),
        autoCooldownMinutes: Math.min(120, Math.max(0, Number(form.autoCooldownMinutes) ?? 5)),
      },
    })
    msg.value = t('config.saved'); emit('changed')
  } catch (e: any) { msg.value = e?.data?.statusMessage || t('config.saveFailed') }
  finally { savingInfo.value = false }
}
const ask = useConfirm()
async function deleteProject() {
  if (!(await ask({ title: t('config.deleteProject'), message: t('config.confirm.deleteProjectMsg', { name: props.project.name }), okText: t('common.delete'), danger: true }))) return
  await $fetch(`/api/projects/${props.project.id}`, { method: 'DELETE' })
  emit('deleted')
}

// ── Skills ──
type SkillRow = Skill & { warnings: string[] }
const { data: skills, refresh: refreshSkills } = useFetch<SkillRow[]>(() => `/api/projects/${props.project.id}/skills`)
const activeId = ref(props.project.activeSkillId)
const previewId = ref<string | null>(null)
const previewSkill = computed(() => skills.value?.find((s) => s.id === previewId.value) || null)
const activeSkill = computed(() => skills.value?.find((s) => s.id === activeId.value) || null)
const generating = ref(false)

async function doActivate(id: string) {
  await $fetch(`/api/projects/${props.project.id}`, { method: 'PATCH', body: { activeSkillId: id } })
  activeId.value = id; emit('changed'); msg.value = t('config.skillActivated')
}
// 启用前体检：命中红线先警告确认
const lintModal = reactive({ open: false, id: '', name: '', warnings: [] as string[] })
function activate(id: string) {
  const s = skills.value?.find((x) => x.id === id)
  if (s && s.warnings?.length) {
    Object.assign(lintModal, { open: true, id, name: s.name, warnings: s.warnings })
  } else {
    doActivate(id)
  }
}
function confirmActivate() {
  lintModal.open = false
  doActivate(lintModal.id)
}
// 点 ⚠ 查看体检详情
const warnModal = reactive({ open: false, name: '', warnings: [] as string[] })
function showWarn(s: SkillRow) {
  Object.assign(warnModal, { open: true, name: s.name, warnings: s.warnings || [] })
}
async function delSkill(id: string) {
  if (!(await ask({ title: t('config.confirm.deleteSkillTitle'), message: t('config.confirm.deleteSkillMsg'), okText: t('common.delete'), danger: true }))) return
  await $fetch(`/api/skills/${id}`, { method: 'DELETE' })
  if (previewId.value === id) previewId.value = null
  if (activeId.value === id) activeId.value = null
  await refreshSkills()
}
// 生成/赋能前先让用户给自定义指令（可介入，不无脑跑）
const showGen = ref(false)
const genBaseId = ref<string | null>(null) // null=从零生成；有值=基于它优化
const genInstruction = ref('')
function openGen(baseId: string | null) {
  genBaseId.value = baseId
  genInstruction.value = ''
  showGen.value = true
}
const genProgress = ref('')
async function runGen() {
  showGen.value = false
  generating.value = true; msg.value = ''; genProgress.value = t('config.connecting')
  // 开 SSE 看实时进度（agent 在读哪个文件 / grep 什么）
  let es: EventSource | null = null
  if (import.meta.client) {
    es = new EventSource(`/api/projects/${props.project.id}/skills/genstream`)
    es.onmessage = (ev) => {
      try {
        const e = JSON.parse(ev.data)
        if (e.message) genProgress.value = e.message
      } catch {}
    }
  }
  try {
    const row = await $fetch<Skill>(`/api/projects/${props.project.id}/skills/generate`, {
      method: 'POST',
      body: {
        ...(genBaseId.value ? { baseSkillId: genBaseId.value } : {}),
        ...(genInstruction.value.trim() ? { instruction: genInstruction.value.trim() } : {}),
      },
    })
    await refreshSkills()
    previewId.value = row.id // 直接预览新候选，做对比
    msg.value = t('config.candidateGenerated')
  } catch (e: any) {
    // HTTP 可能超时但 skill 其实已生成并写库 → 刷新一下看是否多了候选
    await refreshSkills().catch(() => {})
    msg.value = e?.data?.statusMessage || t('config.genInterrupted')
  }
  finally { generating.value = false; genProgress.value = ''; es?.close() }
}
const showNew = ref(false)
const newForm = reactive({ name: '', content: '' })
const creatingSkill = ref(false)
function openNew() {
  newForm.name = t('config.handwrittenSkill')
  newForm.content = ''
  showNew.value = true
}
async function createSkill() {
  if (!newForm.name.trim()) return
  creatingSkill.value = true
  try {
    const row = await $fetch<Skill>(`/api/projects/${props.project.id}/skills`, {
      method: 'POST', body: { name: newForm.name, content: newForm.content },
    })
    showNew.value = false
    await refreshSkills()
    previewId.value = row.id
  } finally { creatingSkill.value = false }
}

// 朴素行级 diff（候选 vs 当前启用）
type DiffLine = { t: '+' | '-' | ' '; text: string }
function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = (oldText || '').split('\n'), b = (newText || '').split('\n')
  const n = a.length, m = b.length
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1] + 1 : Math.max(dp[i + 1]![j], dp[i]![j + 1])
  const out: DiffLine[] = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ t: ' ', text: a[i]! }); i++; j++ }
    else if (dp[i + 1]![j] >= dp[i]![j + 1]) { out.push({ t: '-', text: a[i]! }); i++ }
    else { out.push({ t: '+', text: b[j]! }); j++ }
  }
  while (i < n) out.push({ t: '-', text: a[i++]! })
  while (j < m) out.push({ t: '+', text: b[j++]! })
  return out
}
const diff = computed(() => {
  if (!previewSkill.value) return []
  if (!activeSkill.value || activeSkill.value.id === previewSkill.value.id) return null
  return lineDiff(activeSkill.value.content, previewSkill.value.content)
})
const SRC: Record<string, string> = { manual: 'config.src.manual', file: 'config.src.file', ai: 'config.src.ai', optimized: 'config.src.optimized' }
function srcLabel(source: string) {
  const k = SRC[source]
  return k ? t(k) : source
}
function stageLabel(id: ProviderStageId) {
  return t(`config.stage.${id}`)
}
function stageHint(id: ProviderStageId) {
  return t(`config.stageHint.${id}`)
}
function supportLabel(supported: boolean) {
  return supported ? t('config.stageSupported') : t('config.stageUnsupported')
}
function supportClass(supported: boolean, active: boolean) {
  if (!supported) return 'border-default text-dimmed bg-transparent'
  return active
    ? 'border-inverted text-highlighted bg-muted'
    : 'border-success/30 text-success bg-success/10'
}
function codexInstallLabel(status: CodexSdkStatus | null) {
  if (!status) return t('config.codexInstall.unknown')
  return status.installed ? t('config.codexInstall.installed') : t('config.codexInstall.missing')
}
function codexInstallClass(status: CodexSdkStatus | null) {
  if (!status) return 'text-dimmed'
  return status.installed ? 'text-success' : 'text-error'
}
function codexAuthLabel(status: CodexSdkStatus | null) {
  return t(`config.codexAuth.${status?.authStatus || 'unknown'}`)
}
function codexAuthClass(status: CodexSdkStatus | null) {
  if (status?.authStatus === 'authenticated') return 'text-success'
  if (status?.authStatus === 'missing') return 'text-warning'
  return 'text-dimmed'
}
</script>

<template>
  <div class="py-4">
    <!-- 项目信息 -->
    <section>
      <div class="text-[10px] uppercase tracking-[0.15em] text-dimmed mb-3">{{ $t('config.projectInfo') }}</div>
      <div class="space-y-3">
        <label class="block"><span class="text-xs text-dimmed">{{ $t('layout.form.name') }}</span>
          <input v-model="form.name" class="w-full text-sm border-b border-default focus:border-inverted outline-none py-1" /></label>
        <label class="block"><span class="text-xs text-dimmed">{{ $t('layout.form.repo') }}</span>
          <input v-model="form.repo" class="w-full text-sm border-b border-default focus:border-inverted outline-none py-1" /></label>
        <label class="block"><span class="text-xs text-dimmed">{{ $t('config.localPathShort') }}</span>
          <input v-model="form.localPath" class="w-full text-sm font-mono border-b border-default focus:border-inverted outline-none py-1" /></label>
        <label class="block"><span class="text-xs text-dimmed">{{ $t('layout.form.defaultBranch') }}</span>
          <input v-model="form.defaultBranch" class="w-full text-sm border-b border-default focus:border-inverted outline-none py-1" /></label>
      </div>
    </section>

    <!-- 模型 -->
    <section class="mt-8">
      <!-- 三列：标签都对齐「审核 Provider」基线（text-[10px] uppercase），说明都对齐「当前选择」基线（text-xs），控件在下一行 -->
      <div class="flex flex-wrap items-start gap-x-10 gap-y-4 mb-3">
        <!-- 审核 Provider -->
        <div class="flex flex-col">
          <div class="text-[10px] uppercase tracking-[0.15em] text-dimmed">{{ $t('config.providerSection') }}</div>
          <p class="text-xs text-dimmed mt-1">{{ $t('config.selectedProvider', { provider: selectedProviderLabel }) }}</p>
          <div class="inline-flex border border-default rounded overflow-hidden mt-2 self-start">
            <button
              class="px-3 py-1.5 text-sm border-r border-default"
              :class="form.provider === 'claude' ? 'bg-muted text-highlighted' : 'hover:bg-muted'"
              @click="form.provider = 'claude'"
            >{{ $t('config.providerClaude') }}</button>
            <button
              class="px-3 py-1.5 text-sm"
              :class="form.provider === 'codex' ? 'bg-muted text-highlighted' : 'hover:bg-muted'"
              @click="form.provider = 'codex'"
            >{{ $t('config.providerCodex') }}</button>
          </div>
        </div>
        <!-- 自动修复回合上限 -->
        <div class="flex flex-col">
          <div class="text-[10px] uppercase tracking-[0.15em] text-dimmed">{{ $t('config.autoMaxRounds') }}</div>
          <p class="text-xs text-dimmed mt-1">{{ $t('config.autoMaxRoundsHint') }}</p>
          <input
            v-model.number="form.autoMaxRounds" type="number" min="1" max="10"
            class="w-16 text-sm border-b border-default py-1 bg-transparent outline-none focus:border-inverted mt-2"
          />
        </div>
        <!-- 自动化冷却期（分钟） -->
        <div class="flex flex-col">
          <div class="text-[10px] uppercase tracking-[0.15em] text-dimmed">{{ $t('config.autoCooldown') }}</div>
          <p class="text-xs text-dimmed mt-1">{{ $t('config.autoCooldownHint') }}</p>
          <input
            v-model.number="form.autoCooldownMinutes" type="number" min="0" max="120"
            class="w-16 text-sm border-b border-default py-1 bg-transparent outline-none focus:border-inverted mt-2"
          />
        </div>
      </div>

      <div class="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem] max-w-4xl min-w-0">
        <div class="border border-default rounded overflow-x-auto">
          <div class="md:min-w-[22rem]">
          <div class="grid grid-cols-[minmax(0,1fr)_5.5rem_5.5rem] gap-2 px-3 py-2 border-b border-default bg-muted/40 text-[10px] uppercase tracking-[0.12em] text-dimmed">
            <span>{{ $t('config.stageColumn') }}</span>
            <span>{{ $t('config.providerClaude') }}</span>
            <span>{{ $t('config.providerCodex') }}</span>
          </div>
          <div v-if="capsPending && !capabilityStages.length" class="px-3 py-3 text-xs text-dimmed">{{ $t('config.loadingCapabilities') }}</div>
          <div
            v-for="stage in capabilityStages"
            :key="stage.id"
            class="grid grid-cols-[minmax(0,1fr)_5.5rem_5.5rem] gap-2 px-3 py-2 border-b border-default last:border-b-0 text-sm"
          >
            <div class="min-w-0">
              <div class="text-sm text-highlighted">{{ stageLabel(stage.id) }}</div>
              <div class="text-[11px] text-dimmed leading-snug">
                {{ stageHint(stage.id) }}
                <span v-if="!stage.providerControlled"> · {{ $t('config.notProviderControlled') }}</span>
              </div>
            </div>
            <div>
              <span class="inline-flex items-center rounded border px-2 py-0.5 text-[11px]" :class="supportClass(stage.claude, form.provider === 'claude')">
                {{ supportLabel(stage.claude) }}
              </span>
            </div>
            <div>
              <span class="inline-flex items-center rounded border px-2 py-0.5 text-[11px]" :class="supportClass(stage.codex, form.provider === 'codex')">
                {{ supportLabel(stage.codex) }}
              </span>
            </div>
          </div>
          </div>
        </div>

        <!-- provider 状态卡：跟随当前选择的 provider（Claude/Codex 对称展示） -->
        <div class="border border-default rounded p-3 self-start">
          <!-- Codex -->
          <template v-if="form.provider === 'codex'">
            <div class="flex items-center justify-between gap-3">
              <div class="text-[10px] uppercase tracking-[0.12em] text-dimmed">{{ $t('config.codexSdkStatus') }}</div>
              <span v-if="codexStatus?.sdkVersion" class="font-mono text-[10px] text-dimmed">v{{ codexStatus.sdkVersion }}</span>
            </div>
            <div class="mt-3 space-y-2 text-sm">
              <div class="flex items-center justify-between gap-3">
                <span class="text-xs text-dimmed">{{ $t('config.codexSdkInstalled') }}</span>
                <span class="text-xs font-medium" :class="codexInstallClass(codexStatus)">{{ codexInstallLabel(codexStatus) }}</span>
              </div>
              <div class="flex items-center justify-between gap-3">
                <span class="text-xs text-dimmed">{{ $t('config.codexAuthenticated') }}</span>
                <span class="text-xs font-medium" :class="codexAuthClass(codexStatus)">{{ codexAuthLabel(codexStatus) }}</span>
              </div>
            </div>
            <p class="mt-3 text-[11px] leading-relaxed text-dimmed">{{ codexStatus?.detail || $t('config.codexStatusUnknown') }}</p>
          </template>
          <!-- Claude -->
          <template v-else>
            <div class="text-[10px] uppercase tracking-[0.12em] text-dimmed">{{ $t('config.claudeStatus') }}</div>
            <div class="mt-3 space-y-2 text-sm">
              <div class="flex items-center justify-between gap-3">
                <span class="text-xs text-dimmed">{{ $t('config.claudeCli') }}</span>
                <span class="text-xs font-medium" :class="claudeStatus.ready ? 'text-success' : 'text-error'">
                  {{ claudeStatus.ready ? $t('config.claudeReady') : $t('config.claudeUnavailable') }}
                </span>
              </div>
              <div class="flex items-center justify-between gap-3">
                <span class="text-xs text-dimmed">{{ $t('config.claudeModels') }}</span>
                <span class="text-xs font-medium text-dimmed">{{ claudeStatus.modelCount }}</span>
              </div>
            </div>
            <p class="mt-3 text-[11px] leading-relaxed text-dimmed">{{ claudeStatus.detail || $t('config.claudeStatusUnknown') }}</p>
          </template>
        </div>
      </div>
    </section>

    <!-- 模型列表：同一个组件，跟随 provider（claude=本地真实模型；codex=预设列表） -->
    <section class="mt-8">
      <div class="text-[10px] uppercase tracking-[0.15em] text-dimmed mb-2">{{ form.provider === 'codex' ? $t('config.codexModelSection') : $t('config.claudeModelSection') }}</div>
      <p class="text-xs text-dimmed mb-3 max-w-2xl">{{ form.provider === 'codex' ? $t('config.codexModelHint') : $t('config.claudeModelHint') }}</p>
      <div class="space-y-1 max-w-2xl">
        <button
          v-for="m in activeModelOptions"
          :key="m.value"
          class="w-full text-left flex items-start gap-3 px-3 py-2 rounded border transition-colors"
          :class="form.model === m.value ? 'border-inverted bg-muted' : 'border-default hover:border-accented'"
          @click="form.model = m.value"
        >
          <span class="w-3 shrink-0 text-highlighted text-sm leading-6">{{ form.model === m.value ? '✓' : '' }}</span>
          <span class="min-w-0">
            <span class="text-sm font-medium">{{ m.displayName }}</span>
            <span v-if="m.supportsEffort" class="ml-2 text-[10px] text-dimmed">effort: {{ m.effortLevels.join('/') }}</span>
            <span class="block text-xs text-dimmed mt-0.5">{{ m.description || (m.value ? '' : $t('config.inheritEnvDefault')) }}</span>
          </span>
        </button>
      </div>

      <div v-if="effortOptions.length" class="mt-4">
        <span class="text-xs text-dimmed">{{ $t('config.effortLabel') }}</span>
        <select v-model="form.effort" class="block text-sm border-b border-default py-1 bg-transparent outline-none min-w-32">
          <option value="">{{ $t('config.effortNone') }}</option>
          <option v-for="e in effortOptions" :key="e" :value="e">{{ e }}</option>
        </select>
      </div>
      <p v-else class="text-xs text-dimmed mt-3">{{ $t('config.noEffortSupport') }}</p>
    </section>

    <div class="mt-6 flex items-center gap-4">
      <button class="text-sm bg-inverted text-inverted px-5 py-2 hover:bg-inverted/90 disabled:opacity-40" :disabled="savingInfo" @click="saveInfo">{{ savingInfo ? $t('config.saving') : $t('config.saveConfig') }}</button>
      <span class="text-xs text-dimmed">{{ msg }}</span>
    </div>

    <!-- Skills -->
    <section class="mt-12 border-t border-default pt-8">
      <div class="flex items-center justify-between mb-3">
        <div class="text-[10px] uppercase tracking-[0.15em] text-dimmed">{{ $t('config.skillsSection') }}</div>
        <div class="flex gap-3 text-xs">
          <button class="text-muted hover:text-highlighted" @click="openNew">{{ $t('config.addBlank') }}</button>
          <button class="text-muted hover:text-highlighted disabled:opacity-40" :disabled="generating || !project.localPath" @click="openGen(null)">{{ $t('config.aiGenerate') }}</button>
          <button class="text-muted hover:text-highlighted disabled:opacity-40" :disabled="generating || !activeId || !project.localPath" @click="openGen(activeId!)">{{ $t('config.aiOptimize') }}</button>
        </div>
      </div>
      <p v-if="generating" class="text-xs text-muted mb-3 truncate">
        <span class="inline-block w-1.5 h-1.5 rounded-full bg-inverted animate-pulse mr-1.5" />{{ $t('config.aiGenerating') }} · <span class="font-mono text-dimmed">{{ genProgress || $t('config.readingCode') }}</span>
      </p>
      <p v-if="!project.localPath" class="text-xs text-dimmed mb-3">{{ $t('config.localPathRequired') }}</p>

      <div v-for="s in skills" :key="s.id" class="flex items-center gap-3 py-2 border-b border-default text-sm">
        <span class="w-3 shrink-0">
          <span v-if="s.id === activeId" class="text-highlighted" :title="$t('config.activeTitle')">●</span>
        </span>
        <span class="flex-1 min-w-0 flex items-center gap-2">
          <span class="truncate" :class="s.id === activeId ? 'text-highlighted font-medium' : 'text-toned'">{{ s.name }}</span>
          <span class="text-[10px] text-dimmed shrink-0">{{ srcLabel(s.source) }}</span>
          <button
            v-if="s.warnings?.length"
            class="text-[11px] text-warning hover:text-warning shrink-0"
            @click="showWarn(s)"
          >{{ $t('config.warnCount', { count: s.warnings.length }) }}</button>
        </span>
        <button class="text-xs text-dimmed hover:text-highlighted" @click="previewId = previewId === s.id ? null : s.id">{{ $t('config.preview') }}</button>
        <button v-if="s.id !== activeId" class="text-xs text-muted hover:text-highlighted" @click="activate(s.id)">{{ $t('config.enable') }}</button>
        <button class="text-xs text-dimmed hover:text-highlighted" @click="delSkill(s.id)">{{ $t('common.delete') }}</button>
      </div>
      <p v-if="!skills?.length" class="text-sm text-dimmed py-3">{{ $t('config.noSkills') }}</p>

      <!-- 预览 / diff -->
      <div v-if="previewSkill" class="mt-4 border border-default rounded p-3">
        <div class="flex items-center justify-between mb-2">
          <span class="text-xs text-muted">{{ previewSkill.name }}<span v-if="diff" class="text-dimmed"> {{ $t('config.vsActive') }}</span></span>
          <button v-if="previewId !== activeId" class="text-xs bg-inverted text-inverted px-3 py-1 hover:bg-inverted/90" @click="activate(previewSkill.id)">{{ $t('config.enableThis') }}</button>
        </div>
        <!-- 有对比则显示 diff，否则纯文本 -->
        <div v-if="diff" class="font-mono text-xs leading-relaxed max-h-96 overflow-auto">
          <div v-for="(l, i) in diff" :key="i" class="whitespace-pre-wrap px-2"
            :class="l.t === '+' ? 'bg-success/10 text-success' : l.t === '-' ? 'bg-error/10 text-error' : 'text-muted'">{{ l.t }} {{ l.text || ' ' }}</div>
        </div>
        <pre v-else class="text-xs text-toned whitespace-pre-wrap max-h-96 overflow-auto font-sans">{{ previewSkill.content }}</pre>
      </div>
    </section>

    <!-- 删除项目 -->
    <section class="mt-12 border-t border-default pt-6">
      <button class="text-xs text-error hover:text-error" @click="deleteProject">{{ $t('config.deleteProject') }}</button>
    </section>

    <!-- 点 ⚠ 查看体检详情 -->
    <BaseModal v-model:open="warnModal.open" :title="$t('config.warnModal.title')">
      <div class="space-y-3">
        <p class="text-sm text-toned" v-html="$t('config.warnModal.body', { name: warnModal.name })" />
        <ul class="text-sm text-default list-disc pl-5 space-y-1">
          <li v-for="(w, i) in warnModal.warnings" :key="i">{{ w }}</li>
        </ul>
        <p class="text-xs text-dimmed leading-relaxed" v-html="$t('config.warnModal.note')" />
      </div>
      <template #footer>
        <button class="text-sm bg-inverted text-inverted px-4 py-2 hover:bg-inverted/90" @click="warnModal.open = false">{{ $t('config.warnModal.gotIt') }}</button>
      </template>
    </BaseModal>

    <!-- 启用前体检警告 -->
    <BaseModal v-model:open="lintModal.open" :title="$t('config.lintModal.title')">
      <div class="space-y-3">
        <p class="text-sm text-toned" v-html="$t('config.lintModal.body', { name: lintModal.name })" />
        <ul class="text-sm text-default list-disc pl-5 space-y-1">
          <li v-for="(w, i) in lintModal.warnings" :key="i">{{ w }}</li>
        </ul>
        <p class="text-xs text-dimmed">{{ $t('config.lintModal.note') }}</p>
      </div>
      <template #footer>
        <button class="text-sm text-muted hover:text-highlighted px-3" @click="lintModal.open = false">{{ $t('common.cancel') }}</button>
        <button class="text-sm bg-inverted text-inverted px-4 py-2 hover:bg-inverted/90" @click="confirmActivate">{{ $t('config.lintModal.enableAnyway') }}</button>
      </template>
    </BaseModal>

    <!-- AI 生成 / 赋能：给自定义指令 -->
    <BaseModal v-model:open="showGen" :title="genBaseId ? $t('config.genModal.titleOptimize') : $t('config.genModal.titleGenerate')">
      <div class="space-y-3">
        <p class="text-xs text-muted leading-relaxed" v-html="$t('config.genModal.intro', { mode: genBaseId ? $t('config.genModal.modeOptimize') : $t('config.genModal.modeGenerate') })" />
        <label class="block">
          <span class="text-xs text-dimmed">{{ $t('config.genModal.instructionLabel') }}</span>
          <textarea
            v-model="genInstruction" rows="5"
            :placeholder="$t('config.genModal.instructionPlaceholder')"
            class="w-full text-sm bg-muted border border-default rounded px-2 py-1 mt-1 resize-y outline-none focus:border-accented"
          />
        </label>
      </div>
      <template #footer>
        <button class="text-sm text-muted hover:text-highlighted px-3" @click="showGen = false">{{ $t('common.cancel') }}</button>
        <button class="text-sm bg-inverted text-inverted px-4 py-2 hover:bg-inverted/90" @click="runGen">{{ $t('config.genModal.start') }}</button>
      </template>
    </BaseModal>

    <!-- 新建 skill -->
    <BaseModal v-model:open="showNew" :title="$t('config.newModal.title')">
      <div class="space-y-4">
        <label class="block">
          <span class="text-xs text-dimmed">{{ $t('layout.form.name') }}</span>
          <input v-model="newForm.name" class="w-full text-sm border-b border-default focus:border-inverted outline-none py-1" />
        </label>
        <label class="block">
          <span class="text-xs text-dimmed">{{ $t('config.newModal.contentLabel') }}</span>
          <textarea v-model="newForm.content" rows="8" :placeholder="$t('config.newModal.contentPlaceholder')" class="w-full text-sm font-mono bg-muted border border-default rounded px-2 py-1 mt-1 resize-y outline-none focus:border-accented" />
        </label>
      </div>
      <template #footer>
        <button class="text-sm text-muted hover:text-highlighted px-3" @click="showNew = false">{{ $t('common.cancel') }}</button>
        <button class="text-sm bg-inverted text-inverted px-4 py-2 hover:bg-inverted/90 disabled:opacity-40" :disabled="creatingSkill" @click="createSkill">{{ $t('layout.create') }}</button>
      </template>
    </BaseModal>
  </div>
</template>

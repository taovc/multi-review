<script setup lang="ts">
// Project assistant: floating button + slideover around one SessionView, shown on project pages only. Two workspace
// kinds live here — the project's own directory (cwd) and a fresh feature-branch worktree — picked when a new session
// starts; the history is the project's sessions of both kinds (PR worktree sessions stay in the PR drawer). The chat
// itself — turns, host cards, composer, slash palette — is the shared SessionView; this shell only picks the run.
const { t, locale } = useI18n()
const toast = useToast()
const route = useRoute()

type Ws = 'cwd' | 'branch_worktree'
const WS: Ws[] = ['cwd', 'branch_worktree']
type RunRow = { id: string; title: string | null; description: string | null; provider: string; workspaceType: Ws; workspacePath: string | null; branch: string | null; prUrl: string | null; status: string; busy: boolean; updatedAt: string }

const open = ref(false)
const sessionId = ref<string | null>(null)
const sessionWs = ref<Ws>('cwd') // workspace of the open session
const newWs = ref<Ws>('cwd') // workspace picked for the next session
const activeWs = computed<Ws>(() => (sessionId.value ? sessionWs.value : newWs.value))
const view = ref<'chat' | 'history'>('chat')
const title = ref<string | null>(null)
const renaming = ref(false)
const renameVal = ref('')
const { confirming } = useInlineConfirm()

const currentProjectId = computed(() => {
  if (!route.path.startsWith('/projects/')) return undefined
  const id = route.params.id
  return typeof id === 'string' && id.trim() ? id : undefined
})
// Leaving a project closes the drawer and drops its session; the next open starts fresh in the new project.
watch(currentProjectId, () => { open.value = false; newSession(); hist.value = null; histPage.value = 0 })
function notify(msg: string, ok = false) { toast.add({ title: msg, color: ok ? 'success' : 'error', icon: ok ? 'i-lucide-check' : 'i-lucide-triangle-alert' }) }

// Deep link (inbox → /projects/:id?session=): open the drawer on a given session.
const openSessionRequest = useOpenGlobalSession()
watch(openSessionRequest, (sid) => {
  if (!sid) return
  openSessionRequest.value = null
  open.value = true
  void openHistorySession(sid)
}, { immediate: true })

function newSession() { sessionId.value = null; title.value = null; view.value = 'chat'; confirming.value = '' }
// The workspace kind must be known before SessionView mounts (it decides the default permission mode and the actions).
async function openHistorySession(id: string, ws?: Ws) {
  confirming.value = ''
  if (ws) sessionWs.value = ws
  else {
    try {
      const r = await $fetch<{ run: { title: string | null; workspaceType: string } }>(`/api/runs/${id}`)
      sessionWs.value = r.run.workspaceType === 'branch_worktree' ? 'branch_worktree' : 'cwd'
      title.value = r.run.title
    } catch (e: any) { notify(e?.data?.statusMessage || t('common.failed')); return }
  }
  sessionId.value = id
  view.value = 'chat'
  if (ws) void refreshTitle()
}
async function refreshTitle() {
  if (!sessionId.value) return
  try { const r = await $fetch<{ run: { title: string | null } }>(`/api/runs/${sessionId.value}`); title.value = r.run.title } catch { /* ignore */ }
}
function onCreated(id: string, ws: string) { sessionWs.value = ws === 'branch_worktree' ? 'branch_worktree' : 'cwd'; sessionId.value = id; void refreshTitle() }
async function deleteSession() {
  confirming.value = ''
  if (!sessionId.value) return
  try { await $fetch(`/api/runs/${sessionId.value}`, { method: 'DELETE' }); newSession() }
  catch (e: any) { notify(e?.data?.statusMessage || t('common.failed')) }
}
async function saveRename() {
  const v = renameVal.value.trim()
  renaming.value = false
  if (!sessionId.value || !v) return
  title.value = v
  await $fetch(`/api/runs/${sessionId.value}`, { method: 'PATCH', body: { title: v } }).catch(() => {})
}
async function fork() {
  if (!sessionId.value) return
  try {
    const r = await $fetch<{ id: string }>(`/api/runs/${sessionId.value}/fork`, { method: 'POST' })
    notify(t('session.forked'), true)
    void openHistorySession(r.id, sessionWs.value)
  } catch (e: any) { notify(e?.data?.statusMessage || t('common.failed')) }
}

// ── history ──
type HistResp = { runs: RunRow[]; total: number; page: number; pageSize: number; hasNext: boolean }
const hist = ref<HistResp | null>(null)
const histPage = ref(0)
async function loadHistory() {
  if (!currentProjectId.value) return
  hist.value = await $fetch<HistResp>('/api/runs', { query: { workspaceType: 'cwd,branch_worktree', projectId: currentProjectId.value, page: histPage.value, pageSize: 12 } })
}
function showHistory() { view.value = 'history'; void loadHistory() }
// Branch sessions keep running in the background: refresh the list while it is on screen (like the old feature list did).
let pollTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => { pollTimer = setInterval(() => { if (open.value && view.value === 'history' && document.visibilityState !== 'hidden') void loadHistory() }, 8000) })
onBeforeUnmount(() => { if (pollTimer) clearInterval(pollTimer) })
function histPrev() { if (histPage.value > 0) { histPage.value--; loadHistory() } }
function histNext() { if (hist.value?.hasNext) { histPage.value++; loadHistory() } }
function fmtTime(iso: string) { return new Date(iso).toLocaleString(locale.value, { hour12: false }) }
// Branch sessions show their lifecycle like the old feature list did; directory sessions show where they run.
function statusKey(s: RunRow): string {
  if (s.prUrl) return 'feature.status.opened'
  if (s.status === 'error') return 'feature.status.error'
  if (s.status === 'awaiting_input') return 'feature.status.awaiting'
  return 'feature.status.working'
}
// Per-row rename / delete without opening the session (the header controls only act on the open one).
const editingId = ref<string | null>(null)
const editVal = ref('')
function startEdit(s: RunRow) { editingId.value = s.id; editVal.value = s.title || '' }
async function saveEdit(s: RunRow) {
  const id = editingId.value
  const v = editVal.value.trim()
  editingId.value = null
  if (id !== s.id || !v || v === (s.title || '')) return
  try {
    await $fetch(`/api/runs/${id}`, { method: 'PATCH', body: { title: v } })
    s.title = v
    if (sessionId.value === id) title.value = v
  } catch (e: any) { notify(e?.data?.statusMessage || t('common.failed')) }
}
async function deleteHistory(id: string) {
  confirming.value = ''
  try {
    await $fetch(`/api/runs/${id}`, { method: 'DELETE' })
    if (sessionId.value === id) { sessionId.value = null; title.value = null }
    await loadHistory()
  } catch (e: any) { notify(e?.data?.statusMessage || t('common.failed')) }
}
</script>

<template>
  <template v-if="currentProjectId">
    <button
      class="fixed bottom-6 right-6 z-50 w-12 h-12 rounded-full bg-inverted text-inverted shadow-lg flex items-center justify-center hover:scale-105 active:scale-95 transition-transform"
      :title="$t('global.fabTitle')" @click="open = true"
    >
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <path d="M20 12a8 8 0 0 1-11.3 7.3L4 20l.9-4.2A8 8 0 1 1 20 12Z" />
        <path d="M12 8.3l.95 2.25 2.25.95-2.25.95L12 14.7l-.95-2.25L8.8 11.5l2.25-.95L12 8.3Z" fill="currentColor" stroke="none" />
      </svg>
    </button>

    <USlideover v-model:open="open" :title="$t('global.title')" :ui="{ content: 'w-[100vw] max-w-full min-w-0 md:w-[calc(100vw-15rem)] md:min-w-[640px] md:max-w-none' }">
      <template #body>
        <div class="flex flex-col h-full min-h-0">
          <!-- Header: session controls + workspace picker (new) or badge (open) + editable title -->
          <div class="shrink-0 flex items-center gap-2 pb-2 mb-2 border-b border-default text-xs">
            <button class="px-2 py-1 rounded border border-default hover:bg-muted" @click="newSession">{{ $t('global.newSession') }}</button>
            <button class="px-2 py-1 rounded border border-default hover:bg-muted" :class="view === 'history' ? 'bg-muted text-highlighted' : ''" @click="showHistory">{{ $t('global.history') }}</button>
            <div v-if="!sessionId" class="flex rounded border border-default overflow-hidden shrink-0">
              <button v-for="w in WS" :key="w" class="px-2 py-1" :class="newWs === w ? 'bg-inverted text-inverted' : 'text-dimmed hover:bg-muted hover:text-highlighted'" :title="$t(`global.wsHint.${w}`)" @click="newWs = w">{{ $t(`global.ws.${w}`) }}</button>
            </div>
            <span v-else class="px-2 py-1 rounded border border-default text-dimmed shrink-0 whitespace-nowrap">{{ $t(`global.ws.${sessionWs}`) }}</span>
            <input
              v-if="renaming" v-model="renameVal" class="flex-1 min-w-0 text-xs border-b border-inverted outline-none bg-transparent py-0.5"
              :placeholder="$t('global.untitled')" @keydown.enter="$event.isComposing || saveRename()" @blur="saveRename"
            />
            <button v-else-if="sessionId" class="flex-1 min-w-0 truncate text-left text-dimmed hover:text-highlighted" :title="$t('global.rename')" @click="renameVal = title || ''; renaming = true">{{ title || $t('global.untitled') }}</button>
            <span v-else class="flex-1 min-w-0 truncate text-dimmed">{{ $t(`global.wsHint.${newWs}`) }}</span>
            <button v-if="sessionId && sessionWs === 'cwd'" class="px-2 py-1 rounded border border-default hover:bg-muted shrink-0" :title="$t('session.forkHint')" @click="fork">{{ $t('session.fork') }}</button>
            <template v-if="confirming === 'delete'">
              <span class="text-dimmed">{{ sessionWs === 'branch_worktree' ? $t('feature.discardConfirm') : $t('global.confirmDelete') }}</span>
              <button class="text-error font-medium hover:underline" @click="deleteSession">{{ $t('common.delete') }}</button>
              <button class="text-dimmed hover:text-highlighted" @click="confirming = ''">{{ $t('common.cancel') }}</button>
            </template>
            <button v-else-if="sessionId" class="px-2 py-1 rounded border border-default text-error hover:bg-muted shrink-0" @click="confirming = 'delete'">{{ $t('common.delete') }}</button>
          </div>

          <!-- History list: this project's directory + branch sessions -->
          <div v-if="view === 'history'" class="flex-1 min-h-0 overflow-y-auto">
            <div v-if="!hist?.runs.length" class="text-xs text-dimmed py-8 text-center">{{ $t('global.historyEmpty') }}</div>
            <div v-for="s in hist?.runs ?? []" :key="s.id" class="flex items-start gap-2 px-3 py-2 rounded border border-default hover:border-accented mb-1.5">
              <div class="flex-1 min-w-0">
                <input
                  v-if="editingId === s.id" :ref="(el) => (el as HTMLInputElement | null)?.focus()" v-model="editVal"
                  class="w-full text-sm border-b border-inverted outline-none bg-transparent py-0.5" :placeholder="$t('global.untitled')"
                  @keydown.enter="$event.isComposing || saveEdit(s)" @keydown.esc="editingId = null" @blur="saveEdit(s)"
                />
                <button v-else class="w-full text-left text-sm truncate" @click="openHistorySession(s.id, s.workspaceType)">{{ s.title || s.description || $t('global.untitled') }}</button>
                <div class="text-[11px] text-dimmed flex gap-2 min-w-0">
                  <span class="shrink-0">{{ fmtTime(s.updatedAt) }}</span><span class="font-mono shrink-0">{{ s.provider }}</span>
                  <span class="shrink-0 uppercase tracking-wider text-[10px] px-1.5 border border-default rounded-full">{{ $t(`global.ws.${s.workspaceType}`) }}</span>
                  <span v-if="s.busy" class="shrink-0 inline-block w-1.5 h-1.5 rounded-full bg-inverted animate-pulse self-center" :title="$t('feature.status.working')" />
                  <template v-if="s.workspaceType === 'branch_worktree'">
                    <span class="shrink-0">{{ $t(statusKey(s)) }}</span>
                    <span v-if="s.branch" class="font-mono truncate">{{ s.branch }}</span>
                    <a v-if="s.prUrl" :href="s.prUrl" target="_blank" rel="noopener" class="font-mono truncate hover:text-highlighted" @click.stop>{{ s.prUrl.replace(/^https?:\/\/github\.com\//, '') }}</a>
                  </template>
                  <span v-else class="font-mono truncate">{{ s.workspacePath }}</span>
                </div>
              </div>
              <div class="shrink-0 flex items-center gap-1 text-xs pt-0.5">
                <template v-if="confirming === `del:${s.id}`">
                  <span class="text-dimmed">{{ s.workspaceType === 'branch_worktree' ? $t('feature.discardConfirm') : $t('global.confirmDelete') }}</span>
                  <button class="text-error font-medium hover:underline" @click="deleteHistory(s.id)">{{ $t('common.delete') }}</button>
                  <button class="text-dimmed hover:text-highlighted" @click="confirming = ''">{{ $t('common.cancel') }}</button>
                </template>
                <template v-else>
                  <button class="p-1 text-dimmed hover:text-highlighted" :title="$t('global.rename')" @click="startEdit(s)"><UIcon name="i-lucide-pencil" class="size-3.5" /></button>
                  <button class="p-1 text-dimmed hover:text-error" :title="$t('global.deleteSession')" @click="confirming = `del:${s.id}`"><UIcon name="i-lucide-trash-2" class="size-3.5" /></button>
                </template>
              </div>
            </div>
            <div v-if="hist && hist.total > hist.pageSize" class="flex items-center justify-between text-xs text-dimmed mt-2">
              <button class="hover:text-highlighted disabled:opacity-30" :disabled="histPage === 0" @click="histPrev">{{ $t('project.pagination.prev') }}</button>
              <span>{{ hist.page + 1 }}</span>
              <button class="hover:text-highlighted disabled:opacity-30" :disabled="!hist.hasNext" @click="histNext">{{ $t('project.pagination.next') }}</button>
            </div>
          </div>

          <SessionView
            v-else :run-id="sessionId" :workspace-type="activeWs" :project-id="currentProjectId" :active="open"
            @created="onCreated" @changed="refreshTitle" @deleted="newSession" @clear="newSession" @history="showHistory" @fork="fork"
          />
        </div>
      </template>
    </USlideover>
  </template>
</template>

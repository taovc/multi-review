<script setup lang="ts">
// Global assistant: floating button + slideover around one working-directory SessionView, plus the session list
// (new / history / rename / delete / fork). The chat itself — turns, host cards, composer, slash palette — is the
// shared SessionView; this shell only picks which run it shows.
const { t, locale } = useI18n()
const toast = useToast()
const route = useRoute()

type RunRow = { id: string; title: string | null; provider: string; workspacePath: string | null; status: string; updatedAt: string }

const open = ref(false)
const sessionId = ref<string | null>(null)
const view = ref<'chat' | 'history'>('chat')
const title = ref<string | null>(null)
const renaming = ref(false)
const renameVal = ref('')
const pendingCount = ref(0)
const { confirming } = useInlineConfirm()

const currentProjectId = computed(() => {
  if (!route.path.startsWith('/projects/')) return undefined
  const id = route.params.id
  return typeof id === 'string' && id.trim() ? id : undefined
})
function notify(msg: string, ok = false) { toast.add({ title: msg, color: ok ? 'success' : 'error', icon: ok ? 'i-lucide-check' : 'i-lucide-triangle-alert' }) }

// Deep link from the inbox: open the drawer on a given session.
const openSessionRequest = useOpenGlobalSession()
watch(openSessionRequest, (sid) => {
  if (!sid) return
  openSessionRequest.value = null
  open.value = true
  openHistorySession(sid)
}, { immediate: true })

function newSession() { sessionId.value = null; title.value = null; view.value = 'chat'; confirming.value = '' }
function openHistorySession(id: string) { sessionId.value = id; view.value = 'chat'; confirming.value = ''; void refreshTitle() }
async function refreshTitle() {
  if (!sessionId.value) return
  try { const r = await $fetch<{ run: { title: string | null } }>(`/api/runs/${sessionId.value}`); title.value = r.run.title } catch { /* ignore */ }
}
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
    openHistorySession(r.id)
  } catch (e: any) { notify(e?.data?.statusMessage || t('common.failed')) }
}

// ── history ──
type HistResp = { runs: RunRow[]; total: number; page: number; pageSize: number; hasNext: boolean }
const hist = ref<HistResp | null>(null)
const histPage = ref(0)
async function loadHistory() { hist.value = await $fetch<HistResp>('/api/runs', { query: { workspaceType: 'cwd', page: histPage.value, pageSize: 12 } }) }
function showHistory() { view.value = 'history'; void loadHistory() }
function histPrev() { if (histPage.value > 0) { histPage.value--; loadHistory() } }
function histNext() { if (hist.value?.hasNext) { histPage.value++; loadHistory() } }
function fmtTime(iso: string) { return new Date(iso).toLocaleString(locale.value, { hour12: false }) }
</script>

<template>
  <button
    class="fixed bottom-6 right-6 z-50 w-12 h-12 rounded-full bg-neutral-900 text-white shadow-lg flex items-center justify-center hover:scale-105 active:scale-95 transition-transform"
    :title="$t('global.fabTitle')" @click="open = true"
  >
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <path d="M20 12a8 8 0 0 1-11.3 7.3L4 20l.9-4.2A8 8 0 1 1 20 12Z" />
      <path d="M12 8.3l.95 2.25 2.25.95-2.25.95L12 14.7l-.95-2.25L8.8 11.5l2.25-.95L12 8.3Z" fill="currentColor" stroke="none" />
    </svg>
    <span v-if="pendingCount" class="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-amber-500 text-[10px] text-white flex items-center justify-center">{{ pendingCount }}</span>
  </button>

  <USlideover v-model:open="open" :title="$t('global.title')" :ui="{ content: 'w-[100vw] max-w-full min-w-0 md:w-[calc(100vw-15rem)] md:min-w-[640px] md:max-w-none' }">
    <template #body>
      <div class="flex flex-col h-full min-h-0">
        <!-- Header: session controls + editable title -->
        <div class="shrink-0 flex items-center gap-2 pb-2 mb-2 border-b border-default text-xs">
          <button class="px-2 py-1 rounded border border-default hover:bg-muted" @click="newSession">{{ $t('global.newSession') }}</button>
          <button class="px-2 py-1 rounded border border-default hover:bg-muted" :class="view === 'history' ? 'bg-muted text-highlighted' : ''" @click="showHistory">{{ $t('global.history') }}</button>
          <input
            v-if="renaming" v-model="renameVal" class="flex-1 min-w-0 text-xs border-b border-inverted outline-none bg-transparent py-0.5"
            :placeholder="$t('global.untitled')" @keydown.enter="$event.isComposing || saveRename()" @blur="saveRename"
          />
          <button v-else-if="sessionId" class="flex-1 min-w-0 truncate text-left text-dimmed hover:text-highlighted" :title="$t('global.rename')" @click="renameVal = title || ''; renaming = true">{{ title || $t('global.untitled') }}</button>
          <span v-else class="flex-1" />
          <button v-if="sessionId" class="px-2 py-1 rounded border border-default hover:bg-muted shrink-0" :title="$t('session.forkHint')" @click="fork">{{ $t('session.fork') }}</button>
          <template v-if="confirming === 'delete'">
            <span class="text-dimmed">{{ $t('global.confirmDelete') }}</span>
            <button class="text-error font-medium hover:underline" @click="deleteSession">{{ $t('common.delete') }}</button>
            <button class="text-dimmed hover:text-highlighted" @click="confirming = ''">{{ $t('common.cancel') }}</button>
          </template>
          <button v-else-if="sessionId" class="px-2 py-1 rounded border border-default text-error hover:bg-muted shrink-0" @click="confirming = 'delete'">{{ $t('common.delete') }}</button>
        </div>

        <!-- History list -->
        <div v-if="view === 'history'" class="flex-1 min-h-0 overflow-y-auto">
          <div v-if="!hist?.runs.length" class="text-xs text-dimmed py-8 text-center">{{ $t('global.historyEmpty') }}</div>
          <button v-for="s in hist?.runs ?? []" :key="s.id" class="w-full text-left px-3 py-2 rounded border border-default hover:border-accented mb-1.5" @click="openHistorySession(s.id)">
            <div class="text-sm truncate">{{ s.title || $t('global.untitled') }}</div>
            <div class="text-[11px] text-dimmed flex gap-2"><span>{{ fmtTime(s.updatedAt) }}</span><span class="font-mono">{{ s.provider }}</span><span class="font-mono truncate">{{ s.workspacePath }}</span></div>
          </button>
          <div v-if="hist && hist.total > hist.pageSize" class="flex items-center justify-between text-xs text-dimmed mt-2">
            <button class="hover:text-highlighted disabled:opacity-30" :disabled="histPage === 0" @click="histPrev">{{ $t('project.pagination.prev') }}</button>
            <span>{{ hist.page + 1 }}</span>
            <button class="hover:text-highlighted disabled:opacity-30" :disabled="!hist.hasNext" @click="histNext">{{ $t('project.pagination.next') }}</button>
          </div>
        </div>

        <SessionView
          v-else :run-id="sessionId" workspace-type="cwd" :project-id="currentProjectId" :active="open"
          @created="(id) => { sessionId = id; void refreshTitle() }" @changed="refreshTitle" @deleted="newSession" @clear="newSession" @history="showHistory" @fork="fork"
        />
      </div>
    </template>
  </USlideover>
</template>

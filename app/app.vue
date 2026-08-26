<script setup lang="ts">
import type { Project } from '~core/db/schema'

const { t } = useI18n()

useHead({
  title: 'PR Cockpit',
  meta: [{ name: 'description', content: () => t('layout.metaDescription') }],
  link: [{ rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
})

const { data: projects, refresh } = await useFetch<Project[]>('/api/projects')
const route = useRoute()
// Inbox badge: how many things wait for the human (polled; cheap read query).
const inboxCount = ref(0)
let inboxTimer: ReturnType<typeof setInterval> | null = null
async function refreshInbox() {
  try { inboxCount.value = (await $fetch<{ counts: { total: number } }>('/api/inbox')).counts.total } catch { /* keep the last count */ }
}
onMounted(() => { void refreshInbox(); inboxTimer = setInterval(() => { if (document.visibilityState !== 'hidden') void refreshInbox() }, 30_000) })
onBeforeUnmount(() => { if (inboxTimer) clearInterval(inboxTimer) })

// Electron (macOS) hides the native title bar → leave room on the left of the header for the traffic lights
const isElectronMac = ref(false)
onMounted(() => {
  if (typeof navigator !== 'undefined') {
    isElectronMac.value = /Electron/.test(navigator.userAgent) && /Mac/i.test(navigator.userAgent)
  }
})

const showCreate = ref(false)
const showDepotPicker = ref(false)
const showClonePicker = ref(false)
const form = reactive({ name: '', repo: '', localPath: '', defaultBranch: 'dev', methodologyRef: '' })
const creating = ref(false)
const error = ref('')

// Pick the repo: browse to a local git clone → derive owner/repo (the PR identity) from its origin.
// Also use that local clone path as the default for the local clone path field (the worktree source, still editable).
function onPickDepot({ path, repo }: { path: string; repo: string | null }) {
  if (repo) {
    form.repo = repo
    if (!form.name.trim()) form.name = repo.split('/')[1] ?? ''
  }
  if (!form.localPath.trim()) form.localPath = path // only used as a default when empty; if already filled, keep the clone path the user chose
}

// Pick the local clone the worktrees come from: changes the path only, leaves the repo identity alone (may point at a different local clone).
function onPickClone({ path }: { path: string; repo: string | null }) {
  form.localPath = path
}

async function createProject() {
  error.value = ''
  creating.value = true
  try {
    const created = await $fetch<Project>('/api/projects', { method: 'POST', body: { ...form } })
    showCreate.value = false
    Object.assign(form, { name: '', repo: '', localPath: '', defaultBranch: 'dev', methodologyRef: '' })
    await refresh()
    await navigateTo(`/projects/${created.id}`)
  } catch (e: any) {
    error.value = e?.data?.statusMessage || e?.message || t('layout.createError')
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <UApp :toaster="{ position: 'top-right' }">
    <div class="h-[100dvh] min-h-[100dvh] flex flex-col bg-default text-default antialiased">
      <!-- Top header: logo on the left / control cluster on the right (language switch + light/dark) -->
      <header
        class="h-16 shrink-0 border-b border-default flex items-center justify-between pr-6"
        :class="isElectronMac ? 'pl-[5.5rem]' : 'pl-6'"
        style="-webkit-app-region: drag"
      >
        <NuxtLink to="/" class="flex items-center gap-2.5" style="-webkit-app-region: no-drag">
          <img src="/logo.svg" alt="" class="w-6 h-6 rounded-md" />
          <span class="text-sm font-medium tracking-[0.18em] uppercase">PR&nbsp;<span class="text-dimmed">Cockpit</span></span>
        </NuxtLink>
        <div class="flex items-center gap-1" style="-webkit-app-region: no-drag">
          <UpdateCheckButton />
          <RemoteAccessButton />
          <LanguageSwitcher />
          <ColorModeToggle />
        </div>
      </header>

      <div class="flex flex-1 min-h-0 flex-col md:flex-row">
        <!-- Left nav -->
        <aside class="w-full md:w-60 shrink-0 border-b md:border-b-0 md:border-r border-default flex flex-col md:min-h-0 max-h-44 md:max-h-none">
          <div class="px-4 md:px-6 pt-4 md:pt-5 pb-3 flex items-center justify-between">
            <span class="text-xs font-medium uppercase tracking-[0.15em] text-muted">{{ $t('layout.projectsTitle') }}</span>
            <button
              class="text-dimmed hover:text-highlighted transition-colors text-lg leading-none"
              :title="$t('layout.createProject')"
              @click="showCreate = true"
            >
              +
            </button>
          </div>

          <nav class="flex-1 overflow-x-auto overflow-y-hidden md:overflow-x-hidden md:overflow-y-auto px-3 pb-3 md:pb-0 flex md:block gap-2 md:gap-0 md:space-y-px">
            <!-- global pages (not tied to a project) -->
            <NuxtLink
              to="/inbox"
              class="block w-52 md:w-auto shrink-0 px-3 py-2 md:mb-1 text-xs uppercase tracking-[0.12em] transition-colors border-b-2 md:border-b-0 md:border-l-2"
              :class="route.path === '/inbox' ? 'border-inverted text-highlighted' : 'border-transparent text-muted hover:text-highlighted'"
            >{{ $t('layout.inbox') }}<span v-if="inboxCount" class="ml-2 inline-block min-w-5 text-center px-1 rounded-full bg-inverted text-inverted normal-case tracking-normal">{{ inboxCount }}</span></NuxtLink>
            <NuxtLink
              to="/dashboard"
              class="block w-52 md:w-auto shrink-0 px-3 py-2 md:mb-1 text-xs uppercase tracking-[0.12em] transition-colors border-b-2 md:border-b-0 md:border-l-2"
              :class="route.path === '/dashboard' ? 'border-inverted text-highlighted' : 'border-transparent text-muted hover:text-highlighted'"
            >{{ $t('layout.dashboard') }}</NuxtLink>
            <NuxtLink
              to="/agent-config"
              class="block w-52 md:w-auto shrink-0 px-3 py-2 md:mb-1 text-xs uppercase tracking-[0.12em] transition-colors border-b-2 md:border-b-0 md:border-l-2"
              :class="route.path === '/agent-config' ? 'border-inverted text-highlighted' : 'border-transparent text-muted hover:text-highlighted'"
            >{{ $t('layout.agentConfig') }}</NuxtLink>
            <NuxtLink
              v-for="p in projects"
              :key="p.id"
              :to="`/projects/${p.id}`"
              class="block w-52 md:w-auto shrink-0 px-3 py-2.5 transition-colors border-b-2 md:border-b-0 md:border-l-2"
              :class="route.params.id === p.id
                ? 'border-inverted text-highlighted'
                : 'border-transparent text-muted hover:text-highlighted'"
            >
              <div class="truncate text-sm font-medium">{{ p.name }}</div>
              <div class="text-xs text-dimmed truncate mt-0.5">{{ p.repo }}</div>
            </NuxtLink>
            <p v-if="!projects?.length" class="px-3 py-4 md:py-8 text-xs text-dimmed leading-relaxed">
              {{ $t('layout.emptyProjects') }}<br />{{ $t('layout.emptyProjectsHint') }}
            </p>
          </nav>
        </aside>

        <!-- Main area -->
        <main class="flex-1 min-w-0 overflow-y-auto bg-default">
          <NuxtPage />
        </main>
      </div>
    </div>

    <!-- Global confirmation dialog (replaces window.confirm) -->
    <AppConfirm />

    <!-- Global do-anything assistant (floating button in the bottom-right + drawer) -->
    <GlobalChat />

    <!-- Create project -->
    <BaseModal v-model:open="showCreate" :title="$t('layout.createProject')">
      <div class="space-y-4">
        <label class="block">
          <span class="text-xs text-dimmed">{{ $t('layout.form.name') }}</span>
          <input v-model="form.name" placeholder="Acme" class="w-full text-sm border-b border-default focus:border-inverted outline-none py-1 placeholder:text-dimmed" />
        </label>
        <label class="block">
          <span class="text-xs text-dimmed">{{ $t('layout.form.repo') }}</span>
          <div class="flex items-center gap-2">
            <input v-model="form.repo" placeholder="acme/web-app" class="flex-1 min-w-0 text-sm border-b border-default focus:border-inverted outline-none py-1 placeholder:text-dimmed" />
            <button type="button" class="shrink-0 text-xs text-muted hover:text-highlighted border border-default rounded px-2.5 py-1.5" @click="showDepotPicker = true">{{ $t('layout.picker.browse') }}</button>
          </div>
          <span class="text-[11px] text-dimmed mt-1 block">{{ $t('layout.picker.depotHint') }}</span>
        </label>
        <label class="block">
          <span class="text-xs text-dimmed">{{ $t('layout.form.localPath') }}</span>
          <div class="flex items-center gap-2">
            <input v-model="form.localPath" placeholder="/Users/you/work/acme-app" class="flex-1 min-w-0 text-sm font-mono border-b border-default focus:border-inverted outline-none py-1 placeholder:text-dimmed" />
            <button type="button" class="shrink-0 text-xs text-muted hover:text-highlighted border border-default rounded px-2.5 py-1.5" @click="showClonePicker = true">{{ $t('layout.picker.browse') }}</button>
          </div>
          <span class="text-[11px] text-dimmed mt-1 block">{{ $t('layout.picker.cloneHint') }}</span>
        </label>
        <label class="block">
          <span class="text-xs text-dimmed">{{ $t('layout.form.defaultBranch') }}</span>
          <input v-model="form.defaultBranch" placeholder="dev" class="w-full text-sm border-b border-default focus:border-inverted outline-none py-1 placeholder:text-dimmed" />
        </label>
        <p v-if="error" class="text-sm text-error">{{ error }}</p>
      </div>
      <template #footer>
        <button class="text-sm text-muted hover:text-highlighted px-3" @click="showCreate = false">{{ $t('common.cancel') }}</button>
        <button class="text-sm bg-inverted text-inverted px-4 py-2 hover:bg-inverted/90 disabled:opacity-40" :disabled="creating" @click="createProject">{{ creating ? $t('layout.creating') : $t('layout.create') }}</button>
      </template>
    </BaseModal>

    <!-- Pick the repo: browse a local git clone → derive owner/repo, and use the path as the default clone path -->
    <DirectoryPicker v-model:open="showDepotPicker" :initial-path="form.localPath" @select="onPickDepot" />

    <!-- Pick the local clone path the worktrees come from (defaults to the repo path, editable) -->
    <DirectoryPicker v-model:open="showClonePicker" :initial-path="form.localPath" @select="onPickClone" />
  </UApp>
</template>

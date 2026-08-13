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

// Electron(macOS)隐藏了原生标题栏 → 顶栏左侧给 traffic light 留位
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

// 选 Dépôt：浏览到一个本地 git 克隆 → 由它的 origin 推出 owner/repo（PR 身份）。
// 同时把这个本地克隆路径作为「Chemin du clone local」的默认值（worktree 来源，可再改）。
function onPickDepot({ path, repo }: { path: string; repo: string | null }) {
  if (repo) {
    form.repo = repo
    if (!form.name.trim()) form.name = repo.split('/')[1] ?? ''
  }
  if (!form.localPath.trim()) form.localPath = path // 仅在未填时作为默认；已填则保留用户已选的 clone 路径
}

// 选 worktree 来源的本地克隆：只改路径，不动 Dépôt 身份（可指向另一个本地克隆）。
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
      <!-- 顶部 header：左 logo / 右 控件簇（语言切换 + 深浅色） -->
      <header
        class="h-16 shrink-0 border-b border-default flex items-center justify-between pr-6"
        :class="isElectronMac ? 'pl-[5.5rem]' : 'pl-6'"
        style="-webkit-app-region: drag"
      >
        <NuxtLink to="/" class="flex items-center gap-2.5" style="-webkit-app-region: no-drag">
          <img src="/logo.svg" alt="" class="w-6 h-6 rounded-md" />
          <span class="text-sm font-medium tracking-[0.18em] uppercase">Multi&nbsp;<span class="text-dimmed">Review</span></span>
        </NuxtLink>
        <div class="flex items-center gap-1" style="-webkit-app-region: no-drag">
          <UpdateCheckButton />
          <RemoteAccessButton />
          <LanguageSwitcher />
          <ColorModeToggle />
        </div>
      </header>

      <div class="flex flex-1 min-h-0 flex-col md:flex-row">
        <!-- 左侧导航 -->
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

        <!-- 主区 -->
        <main class="flex-1 min-w-0 overflow-y-auto bg-default">
          <NuxtPage />
        </main>
      </div>
    </div>

    <!-- 全局确认弹窗（替代 window.confirm）-->
    <AppConfirm />

    <!-- 全局「啥都能干」助手（右下角悬浮按钮 + 抽屉）-->
    <GlobalChat />

    <!-- 创建项目 -->
    <BaseModal v-model:open="showCreate" :title="$t('layout.createProject')">
      <div class="space-y-4">
        <label class="block">
          <span class="text-xs text-dimmed">{{ $t('layout.form.name') }}</span>
          <input v-model="form.name" placeholder="Stakimo" class="w-full text-sm border-b border-default focus:border-inverted outline-none py-1 placeholder:text-dimmed" />
        </label>
        <label class="block">
          <span class="text-xs text-dimmed">{{ $t('layout.form.repo') }}</span>
          <div class="flex items-center gap-2">
            <input v-model="form.repo" placeholder="Stakimo/stakimo-app" class="flex-1 min-w-0 text-sm border-b border-default focus:border-inverted outline-none py-1 placeholder:text-dimmed" />
            <button type="button" class="shrink-0 text-xs text-muted hover:text-highlighted border border-default rounded px-2.5 py-1.5" @click="showDepotPicker = true">{{ $t('layout.picker.browse') }}</button>
          </div>
          <span class="text-[11px] text-dimmed mt-1 block">{{ $t('layout.picker.depotHint') }}</span>
        </label>
        <label class="block">
          <span class="text-xs text-dimmed">{{ $t('layout.form.localPath') }}</span>
          <div class="flex items-center gap-2">
            <input v-model="form.localPath" placeholder="/Users/you/work/stakimo-appli" class="flex-1 min-w-0 text-sm font-mono border-b border-default focus:border-inverted outline-none py-1 placeholder:text-dimmed" />
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

    <!-- 选 Dépôt：浏览本地 git 克隆 → 推出 owner/repo，并把路径作为 clone 路径默认值 -->
    <DirectoryPicker v-model:open="showDepotPicker" :initial-path="form.localPath" @select="onPickDepot" />

    <!-- 选 worktree 来源的本地克隆路径（默认跟随 Dépôt，可改） -->
    <DirectoryPicker v-model:open="showClonePicker" :initial-path="form.localPath" @select="onPickClone" />
  </UApp>
</template>

<script setup lang="ts">
import type { Project } from '~core/db/schema'

const { t } = useI18n()

useHead({
  title: 'Multi Review',
  meta: [{ name: 'description', content: () => t('layout.metaDescription') }],
  link: [{ rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
})

const { data: projects, refresh } = await useFetch<Project[]>('/api/projects')
const route = useRoute()

const showCreate = ref(false)
const form = reactive({ name: '', repo: '', localPath: '', defaultBranch: 'dev', methodologyRef: '' })
const creating = ref(false)
const error = ref('')

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
      <header class="h-16 shrink-0 border-b border-default flex items-center justify-between px-6">
        <NuxtLink to="/" class="flex items-center gap-2.5">
          <img src="/logo.svg" alt="" class="w-6 h-6 rounded-md" />
          <span class="text-sm font-medium tracking-[0.18em] uppercase">Multi&nbsp;<span class="text-dimmed">Review</span></span>
        </NuxtLink>
        <div class="flex items-center gap-1">
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
          <input v-model="form.repo" placeholder="Stakimo/stakimo-app" class="w-full text-sm border-b border-default focus:border-inverted outline-none py-1 placeholder:text-dimmed" />
        </label>
        <label class="block">
          <span class="text-xs text-dimmed">{{ $t('layout.form.localPath') }}</span>
          <input v-model="form.localPath" placeholder="/Users/you/work/stakimo-appli" class="w-full text-sm font-mono border-b border-default focus:border-inverted outline-none py-1 placeholder:text-dimmed" />
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
  </UApp>
</template>

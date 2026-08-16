<script setup lang="ts">
// The top-bar "check for updates" button. Only shown in the Electron desktop window (where preload injected window.mrUpdates);
// clicking triggers the main process's manual check, and the main process presents the result in a native dialog (update available → download prompt, none → acknowledgement).
const { t, locale } = useI18n()

type MrUpdates = { check: (locale?: string) => Promise<void>; setLocale?: (locale: string) => void }

const api = ref<MrUpdates | null>(null)
const checking = ref(false)

onMounted(() => {
  const w = window as unknown as { mrUpdates?: MrUpdates }
  if (w.mrUpdates) {
    api.value = w.mrUpdates
    // Push the current app language to the main process on mount, so the silent check dialog at startup uses the right language too
    api.value.setLocale?.(locale.value)
  }
})

// Sync to the main process whenever the language changes inside the app
watch(locale, (l) => api.value?.setLocale?.(l))

async function check() {
  if (!api.value || checking.value) return
  checking.value = true
  try {
    await api.value.check(locale.value)
  } finally {
    checking.value = false
  }
}
</script>

<template>
  <ClientOnly>
    <button
      v-if="api"
      class="text-dimmed hover:text-highlighted transition-colors flex items-center justify-center size-6 disabled:opacity-50"
      :title="t('update.check')"
      :aria-label="t('update.check')"
      :disabled="checking"
      @click="check"
    >
      <UIcon name="i-lucide-refresh-cw" class="size-4" :class="checking ? 'animate-spin' : ''" />
    </button>
    <template #fallback>
      <div class="size-6" />
    </template>
  </ClientOnly>
</template>

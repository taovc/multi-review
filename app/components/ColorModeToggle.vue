<script setup lang="ts">
// Light/dark toggle; persisting the preference is handled by @nuxtjs/color-mode
const { t } = useI18n()
const colorMode = useColorMode()
const isDark = computed({
  get: () => colorMode.value === 'dark',
  set: (v: boolean) => { colorMode.preference = v ? 'dark' : 'light' },
})
</script>

<template>
  <!-- ClientOnly + fallback prevents an SSR hydration mismatch (the server doesn't know the persisted preference) -->
  <ClientOnly>
    <button
      class="text-dimmed hover:text-highlighted transition-colors flex items-center justify-center size-6"
      :title="isDark ? t('common.toggleLight') : t('common.toggleDark')"
      :aria-label="isDark ? t('common.toggleLight') : t('common.toggleDark')"
      @click="isDark = !isDark"
    >
      <UIcon :name="isDark ? 'i-lucide-moon' : 'i-lucide-sun'" class="size-4" />
    </button>
    <template #fallback>
      <div class="size-6" />
    </template>
  </ClientOnly>
</template>

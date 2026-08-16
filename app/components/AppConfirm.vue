<script setup lang="ts">
// confirmState / resolveConfirm are auto-imported by Nuxt from app/composables/useConfirm
const { t } = useI18n()
// Cancel = false; closing (overlay click / ✕) counts as cancel too
const open = computed({
  get: () => confirmState.open,
  set: (v: boolean) => { if (!v) resolveConfirm(false) },
})
// Fall back to the default i18n text when the caller doesn't provide one (follows the language switch)
const title = computed(() => confirmState.title || t('confirm.title'))
const okText = computed(() => confirmState.okText || t('confirm.ok'))
const cancelText = computed(() => confirmState.cancelText || t('common.cancel'))
</script>

<template>
  <BaseModal v-model:open="open" :title="title">
    <p class="text-sm text-default whitespace-pre-wrap leading-relaxed">{{ confirmState.message }}</p>
    <template #footer>
      <button class="text-sm text-muted hover:text-highlighted px-3" @click="resolveConfirm(false)">{{ cancelText }}</button>
      <button
        class="text-sm px-4 py-2"
        :class="confirmState.danger ? 'bg-error text-white hover:bg-error/90' : 'bg-inverted text-inverted hover:bg-inverted/90'"
        @click="resolveConfirm(true)"
      >{{ okText }}</button>
    </template>
  </BaseModal>
</template>

<script setup lang="ts">
import type { FixSteps } from './fixTypes'

const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ launch: [steps: FixSteps] }>()
const { t } = useI18n()

const steps = ref<FixSteps>({ fix: true, simplify: true, tests: true, testsUI: true })

function launch() {
  emit('launch', { ...steps.value })
  open.value = false
}
</script>

<template>
  <BaseModal v-model:open="open" :title="t('fix.modal.title')">
    <p class="text-xs text-dimmed mb-4">{{ t('fix.modal.desc') }}</p>
    <div class="space-y-3">
      <label class="flex items-center gap-3 text-sm cursor-pointer select-none">
        <input v-model="steps.fix" type="checkbox" class="accent-neutral-900 dark:accent-neutral-100" />
        {{ t('fix.modal.fix') }}
      </label>
      <label class="flex items-center gap-3 text-sm cursor-pointer select-none">
        <input v-model="steps.simplify" type="checkbox" class="accent-neutral-900 dark:accent-neutral-100" />
        {{ t('fix.modal.simplify') }}
      </label>
      <label class="flex items-center gap-3 text-sm cursor-pointer select-none">
        <input v-model="steps.tests" type="checkbox" class="accent-neutral-900 dark:accent-neutral-100" />
        {{ t('fix.modal.tests') }} <span class="text-[10px] text-dimmed">· {{ t('fix.modal.slow') }}</span>
      </label>
      <label class="flex items-center gap-3 text-sm cursor-pointer select-none">
        <input v-model="steps.testsUI" type="checkbox" class="accent-neutral-900 dark:accent-neutral-100" />
        {{ t('fix.modal.testsUI') }} <span class="text-[10px] text-dimmed">· {{ t('fix.modal.experimental') }}</span>
      </label>
    </div>
    <template #footer>
      <button class="text-sm text-dimmed hover:text-default px-3 py-1.5" @click="open = false">{{ t('common.cancel') }}</button>
      <button class="text-sm bg-inverted text-inverted px-4 py-1.5 hover:bg-inverted/90 transition-colors" @click="launch">
        {{ t('fix.modal.launch') }}
      </button>
    </template>
  </BaseModal>
</template>

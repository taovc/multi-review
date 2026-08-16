<script setup lang="ts">
// Remote LAN access: the switch + QR code inside the local Electron window, so an iPad/phone can
// scan and reach the same UI. All the work still runs on this machine, the remote end is just a
// browser view. Switch state / authentication is decided server-side by lan-guard.
const { t } = useI18n()

type LanInfo = { enabled: boolean; urls: string[]; link: string | null; qr: string | null }

const open = ref(false)
const isElectron = ref(false)
const info = ref<LanInfo>({ enabled: false, urls: [], link: null, qr: null })
const busy = ref(false)
const error = ref('')
const copied = ref(false)

onMounted(() => {
  // Only the local desktop window shows this control — a remote phone (plain browser) can't see it, so it can't touch the switch.
  isElectron.value = typeof navigator !== 'undefined' && /Electron/.test(navigator.userAgent)
})

async function refreshInfo() {
  try {
    info.value = await $fetch<LanInfo>('/api/lan')
  } catch (e: any) {
    error.value = e?.data?.statusMessage || e?.message || 'failed'
  }
}

async function openPanel() {
  open.value = true
  error.value = ''
  await refreshInfo()
}

async function post(body: Record<string, unknown>) {
  busy.value = true
  error.value = ''
  try {
    info.value = await $fetch<LanInfo>('/api/lan', { method: 'POST', body })
  } catch (e: any) {
    error.value = e?.data?.statusMessage || e?.message || 'failed'
  } finally {
    busy.value = false
  }
}

const setEnabled = (v: boolean) => post({ enabled: v })
const rotate = () => post({ rotate: true })

async function copyLink() {
  if (!info.value.link) return
  try {
    await navigator.clipboard.writeText(info.value.link)
    copied.value = true
    setTimeout(() => (copied.value = false), 1500)
  } catch {
    /* ignored when the clipboard isn't available — the user can still copy the address by hand */
  }
}
</script>

<template>
  <ClientOnly>
    <template v-if="isElectron">
      <button
        class="text-dimmed hover:text-highlighted transition-colors flex items-center justify-center size-6"
        :title="t('remote.title')"
        :aria-label="t('remote.title')"
        @click="openPanel"
      >
        <UIcon :name="info.enabled ? 'i-lucide-wifi' : 'i-lucide-smartphone'" class="size-4" />
      </button>

      <BaseModal v-model:open="open" :title="t('remote.title')">
        <div class="space-y-5">
          <!-- switch -->
          <div class="flex items-start justify-between gap-4">
            <div class="min-w-0">
              <div class="text-sm font-medium">{{ t('remote.toggleLabel') }}</div>
              <p class="text-[11px] text-dimmed mt-0.5 leading-relaxed">{{ t('remote.toggleHint') }}</p>
            </div>
            <USwitch
              :model-value="info.enabled"
              :disabled="busy"
              @update:model-value="setEnabled"
            />
          </div>

          <!-- Security notice (state-independent: acts as a heads-up before enabling, worded so it doesn't reference a link that isn't shown yet)-->
          <p class="text-[11px] leading-relaxed text-warning border border-warning/30 bg-warning/5 rounded px-3 py-2">
            {{ t('remote.warning') }}
          </p>

          <!-- Port exposure note (M4): switching this off does not close the port -->
          <p class="text-[11px] text-dimmed leading-relaxed">{{ t('remote.portNote') }}</p>

          <!-- Once enabled: QR + addresses -->
          <template v-if="info.enabled">
            <div v-if="info.qr" class="flex flex-col items-center gap-3">
              <img :src="info.qr" :alt="t('remote.scanHint')" class="w-44 h-44 rounded-lg border border-default bg-white p-2" />
              <p class="text-[11px] text-dimmed text-center">{{ t('remote.scanHint') }}</p>
            </div>
            <p v-else class="text-xs text-dimmed text-center py-4">{{ t('remote.noNetwork') }}</p>

            <div v-if="info.urls.length" class="space-y-1.5">
              <div class="text-[11px] uppercase tracking-wide text-dimmed">{{ t('remote.urlsLabel') }}</div>
              <div
                v-for="u in info.urls"
                :key="u"
                class="text-xs font-mono text-muted truncate"
              >{{ u }}</div>
            </div>

            <div class="flex items-center gap-2 pt-1">
              <button
                class="text-xs text-muted hover:text-highlighted border border-default rounded px-2.5 py-1.5 disabled:opacity-40"
                :disabled="!info.link"
                @click="copyLink"
              >{{ copied ? t('remote.copied') : t('remote.copy') }}</button>
              <button
                class="text-xs text-muted hover:text-highlighted border border-default rounded px-2.5 py-1.5 disabled:opacity-40"
                :disabled="busy"
                @click="rotate"
              >{{ t('remote.rotate') }}</button>
            </div>
            <p class="text-[11px] text-dimmed leading-relaxed">{{ t('remote.rotateHint') }}</p>
          </template>
          <p v-else class="text-xs text-dimmed leading-relaxed">{{ t('remote.offHint') }}</p>

          <p v-if="error" class="text-sm text-error">{{ error }}</p>
        </div>
      </BaseModal>
    </template>
    <template #fallback>
      <div class="size-6" />
    </template>
  </ClientOnly>
</template>

<script setup lang="ts">
// Inbox: what is waiting for the human. Read-only list with deep links (review drawer / global chat session).
import type { InboxOverview } from '~core/inbox/queries'

const { t } = useI18n()
const { data, refresh } = await useFetch<InboxOverview>('/api/inbox')
const openSession = useOpenGlobalSession()
let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => { timer = setInterval(() => { if (document.visibilityState !== 'hidden') void refresh() }, 15_000) })
onBeforeUnmount(() => { if (timer) clearInterval(timer) })

const box = 'border border-default p-4'
const h2 = 'text-xs uppercase tracking-[0.12em] text-dimmed mb-3'
const row = 'flex items-center justify-between gap-3 py-1.5 border-t border-default text-sm'
const when = (iso: string | null) => iso ? new Date(iso).toLocaleString() : ''
const reviewLink = (r: { projectId: string; prNumber: number; reviewId: string | null }) => `/projects/${r.projectId}?pr=${r.prNumber}${r.reviewId ? `&review=${r.reviewId}` : ''}`
// A session run lives in one of three workspaces: PR worktree (fix tab of the PR drawer), branch worktree (the project's feature list) or a plain cwd (global drawer).
const runLink = (x: { runId: string; workspaceType: string | null; projectId: string | null; prNumber: number | null }) => {
  if (x.workspaceType === 'pr_worktree' && x.projectId && x.prNumber) return `/projects/${x.projectId}?pr=${x.prNumber}&fix=${x.runId}&tab=fix`
  if (x.workspaceType === 'branch_worktree' && x.projectId) return `/projects/${x.projectId}?session=${x.runId}`
  return null
}
</script>

<template>
  <div class="max-w-4xl mx-auto px-6 py-6 space-y-6">
    <div>
      <h1 class="text-lg text-highlighted">{{ t('inbox.title') }}</h1>
      <p class="text-xs text-dimmed mt-1">{{ t('inbox.subtitle') }}</p>
    </div>
    <p v-if="data && !data.counts.total" class="text-sm text-dimmed">{{ t('inbox.empty') }}</p>

    <section v-if="data?.prompts.length" :class="box">
      <h2 :class="h2">{{ t('inbox.prompts') }} ({{ data.prompts.length }})</h2>
      <div v-for="p in data.prompts" :key="p.id" :class="row">
        <div class="min-w-0">
          <span class="text-highlighted">{{ t(`inbox.kind.${p.kind}`) }}</span>
          <span v-if="p.toolName" class="font-mono text-xs ml-2">{{ p.toolName }}</span>
          <span class="text-dimmed ml-2 truncate">{{ p.title || p.sessionTitle || p.runId }}</span>
          <div class="text-xs text-dimmed truncate">{{ p.sessionTitle || t('inbox.session') }} · {{ p.workspacePath }} · {{ t('inbox.since', { t: when(p.createdAt) }) }}</div>
        </div>
        <NuxtLink v-if="runLink(p)" :to="runLink(p)!" class="text-xs border border-default px-2 py-1 hover:border-inverted shrink-0">{{ t('inbox.open') }}</NuxtLink>
        <button v-else class="text-xs border border-default px-2 py-1 hover:border-inverted shrink-0" @click="openSession = p.runId">{{ t('inbox.open') }}</button>
      </div>
    </section>

    <section v-if="data?.drafts.length" :class="box">
      <h2 :class="h2">{{ t('inbox.drafts') }} ({{ data.drafts.length }})</h2>
      <div v-for="r in data.drafts" :key="r.reviewId" :class="row">
        <div class="min-w-0">
          <span class="text-dimmed">{{ r.projectName }}</span> <span class="text-highlighted">#{{ r.prNumber }}</span> <span class="truncate">{{ r.title }}</span>
          <div class="text-xs text-dimmed">{{ t('inbox.findings', { n: r.findings, u: r.unchecked }) }} · {{ when(r.updatedAt) }}</div>
        </div>
        <NuxtLink :to="reviewLink(r)" class="text-xs border border-default px-2 py-1 hover:border-inverted shrink-0">{{ t('inbox.open') }}</NuxtLink>
      </div>
    </section>

    <section v-if="data?.errors.length" :class="box">
      <h2 :class="h2">{{ t('inbox.errors') }} ({{ data.errors.length }})</h2>
      <div v-for="e in data.errors" :key="e.runId" :class="row">
        <div class="min-w-0">
          <span class="text-dimmed">{{ e.projectName || '—' }}</span> <span v-if="e.prNumber" class="text-highlighted">#{{ e.prNumber }}</span> <span class="font-mono text-xs">{{ e.subkind }}</span> <span class="truncate">{{ e.title }}</span>
          <div class="text-xs text-highlighted truncate">{{ e.error }}</div>
          <div class="text-xs text-dimmed">{{ when(e.endedAt) }}</div>
        </div>
        <NuxtLink v-if="e.subkind !== 'session' && e.projectId && e.prNumber" :to="reviewLink({ projectId: e.projectId, prNumber: e.prNumber, reviewId: e.reviewId })" class="text-xs border border-default px-2 py-1 hover:border-inverted shrink-0">{{ t('inbox.open') }}</NuxtLink>
        <NuxtLink v-else-if="e.subkind === 'session' && runLink(e)" :to="runLink(e)!" class="text-xs border border-default px-2 py-1 hover:border-inverted shrink-0">{{ t('inbox.open') }}</NuxtLink>
        <button v-else-if="e.subkind === 'session'" class="text-xs border border-default px-2 py-1 hover:border-inverted shrink-0" @click="openSession = e.runId">{{ t('inbox.open') }}</button>
      </div>
    </section>

    <section v-if="data?.automation.length" :class="box">
      <h2 :class="h2">{{ t('inbox.automation') }}</h2>
      <div v-for="a in data.automation" :key="a.id" class="text-xs py-1 border-t border-default flex gap-2">
        <span class="text-dimmed whitespace-nowrap">{{ when(a.ts) }}</span><span class="text-dimmed">{{ a.projectName }} #{{ a.prNumber }}</span><span class="font-mono">{{ a.kind }}</span><span class="truncate">{{ a.message }}</span>
      </div>
    </section>
  </div>
</template>

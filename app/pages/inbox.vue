<script setup lang="ts">
// Inbox: what is waiting for the human. Read-only list with deep links (review drawer / global chat session).
import type { InboxOverview } from '~core/inbox/queries'

const { t, locale } = useI18n()
const { data, refresh } = await useFetch<InboxOverview>('/api/inbox')
let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => { timer = setInterval(() => { if (document.visibilityState !== 'hidden') void refresh() }, 15_000) })
onBeforeUnmount(() => { if (timer) clearInterval(timer) })

// Every section pages on the client (the API already caps errors / automation to the last 24h). Pages are 1-based
// and clamped on read, so a list that shrinks on refresh never leaves a section on an empty page.
const PER_PAGE = 10
const pages = reactive<Record<string, number>>({ prompts: 1, drafts: 1, errors: 1, automation: 1 })
function pageOf(key: string, list: unknown[]) { return Math.min(pages[key] ?? 1, Math.max(1, Math.ceil(list.length / PER_PAGE))) }
function paged<T>(key: string, list: T[]): T[] { const p = pageOf(key, list); return list.slice((p - 1) * PER_PAGE, p * PER_PAGE) }
// Write the clamp back after every refresh, so a list that shrinks and later grows again does not jump back to the old page.
watch(data, (d) => { if (d) for (const k of Object.keys(pages)) pages[k] = pageOf(k, (d as any)[k] ?? []) })

const box = 'border border-default'
const head = 'px-4 py-3 border-b border-default'
const h2 = 'text-sm text-highlighted'
const hint = 'text-xs text-dimmed mt-0.5 leading-relaxed'
const row = 'flex items-center justify-between gap-3 py-2 border-t border-default text-sm first:border-t-0'
const tag = 'inline-block text-[10px] uppercase tracking-[0.1em] border border-default px-1.5 py-px text-dimmed whitespace-nowrap'
const btn = 'text-xs border border-default px-2 py-1 hover:border-inverted shrink-0'
// Explicit locale + hour12: the server formats with the process locale otherwise, and the client with the browser's (hydration mismatch).
const when = (iso: string | null) => iso ? new Date(iso).toLocaleString(locale.value, { hour12: false }) : ''
const reviewLink = (r: { projectId: string; prNumber: number; reviewId: string | null }) => `/projects/${r.projectId}?pr=${r.prNumber}${r.reviewId ? `&review=${r.reviewId}` : ''}`
// A session run lives in one of three workspaces: PR worktree (fix tab of the PR drawer), or a branch worktree / plain cwd (the project's
// assistant drawer, which only exists on the project page — sessions without a project cannot be opened from here).
const runLink = (x: { runId: string; workspaceType: string | null; projectId: string | null; prNumber: number | null }) => {
  if (x.workspaceType === 'pr_worktree' && x.projectId && x.prNumber) return `/projects/${x.projectId}?pr=${x.prNumber}&fix=${x.runId}&tab=fix`
  if ((x.workspaceType === 'branch_worktree' || x.workspaceType === 'cwd') && x.projectId) return `/projects/${x.projectId}?session=${x.runId}`
  return null
}
// Where an item lives, so the reader knows what "open" leads to. Reviews never keep a workspace: their worktree is
// deleted right after the run, which is why the PR list's "worktree" filter does not find them.
const REVIEW_FAMILY = ['review', 'guided', 'recheck']
function whereLabel(x: { workspaceType: string | null; prNumber?: number | null; subkind?: string }) {
  if (x.subkind && REVIEW_FAMILY.includes(x.subkind)) return t('inbox.where.review')
  if (x.subkind && x.subkind !== 'session') return t('inbox.where.run', { kind: x.subkind })
  if (x.workspaceType === 'pr_worktree') return t('inbox.where.pr', { n: x.prNumber ?? '?' })
  if (x.workspaceType === 'branch_worktree') return t('inbox.where.branch')
  return t('inbox.where.cwd')
}
</script>

<template>
  <div class="max-w-4xl mx-auto px-6 py-6 space-y-6">
    <div>
      <h1 class="text-lg text-highlighted">{{ t('inbox.title') }}</h1>
      <p class="text-xs text-dimmed mt-1">{{ t('inbox.subtitle') }}</p>
    </div>
    <p v-if="data && !data.counts.total" class="text-sm text-dimmed">{{ t('inbox.empty') }}</p>

    <!-- prompts: sessions blocked on a permission / question / plan approval -->
    <section v-if="data?.prompts.length" :class="box">
      <div :class="head"><h2 :class="h2">{{ t('inbox.prompts') }} ({{ data.prompts.length }})</h2><p :class="hint">{{ t('inbox.hint.prompts') }}</p></div>
      <div class="px-4 pb-3">
        <div v-for="p in paged('prompts', data.prompts)" :key="p.id" :class="row">
          <div class="min-w-0">
            <span class="text-highlighted">{{ t(`inbox.kind.${p.kind}`) }}</span>
            <span v-if="p.toolName" class="font-mono text-xs ml-2">{{ p.toolName }}</span>
            <span class="text-dimmed ml-2 truncate">{{ p.title || p.sessionTitle || p.runId }}</span>
            <div class="text-xs text-dimmed truncate mt-0.5"><span :class="tag" class="mr-2">{{ whereLabel(p) }}</span>{{ p.sessionTitle || t('inbox.session') }} · {{ p.workspacePath }} · {{ t('inbox.since', { t: when(p.createdAt) }) }}</div>
          </div>
          <NuxtLink v-if="runLink(p)" :to="runLink(p)!" :class="btn">{{ t('inbox.open') }}</NuxtLink>
        </div>
        <PagerBar :total="data.prompts.length" :per-page="PER_PAGE" :page="pageOf('prompts', data.prompts)" @update:page="(p) => pages.prompts = p" />
      </div>
    </section>

    <!-- drafts: reviews with findings nobody triaged yet -->
    <section v-if="data?.drafts.length" :class="box">
      <div :class="head"><h2 :class="h2">{{ t('inbox.drafts') }} ({{ data.drafts.length }})</h2><p :class="hint">{{ t('inbox.hint.drafts') }}</p></div>
      <div class="px-4 pb-3">
        <div v-for="r in paged('drafts', data.drafts)" :key="r.reviewId" :class="row">
          <div class="min-w-0">
            <span class="text-dimmed">{{ r.projectName }}</span> <span class="text-highlighted">#{{ r.prNumber }}</span> <span class="truncate">{{ r.title }}</span>
            <div class="text-xs text-dimmed mt-0.5"><span :class="tag" class="mr-2">{{ t('inbox.where.review') }}</span>{{ t('inbox.findings', { n: r.findings, u: r.unchecked }) }} · {{ when(r.updatedAt) }}</div>
          </div>
          <NuxtLink :to="reviewLink(r)" :class="btn">{{ t('inbox.open') }}</NuxtLink>
        </div>
        <PagerBar :total="data.drafts.length" :per-page="PER_PAGE" :page="pageOf('drafts', data.drafts)" @update:page="(p) => pages.drafts = p" />
      </div>
    </section>

    <!-- errors: any run that ended in error during the last 24h -->
    <section v-if="data?.errors.length" :class="box">
      <div :class="head"><h2 :class="h2">{{ t('inbox.errors') }} ({{ data.errors.length }})</h2><p :class="hint">{{ t('inbox.hint.errors') }}</p></div>
      <div class="px-4 pb-3">
        <div v-for="e in paged('errors', data.errors)" :key="e.runId" :class="row">
          <div class="min-w-0">
            <span class="text-dimmed">{{ e.projectName || '—' }}</span> <span v-if="e.prNumber" class="text-highlighted">#{{ e.prNumber }}</span> <span class="font-mono text-xs">{{ e.subkind }}</span> <span class="truncate">{{ e.title }}</span>
            <div class="text-xs text-highlighted truncate">{{ e.error }}</div>
            <div class="text-xs text-dimmed mt-0.5"><span :class="tag" class="mr-2">{{ whereLabel(e) }}</span>{{ when(e.endedAt) }}</div>
          </div>
          <NuxtLink v-if="e.subkind !== 'session' && e.projectId && e.prNumber" :to="reviewLink({ projectId: e.projectId, prNumber: e.prNumber, reviewId: e.reviewId })" :class="btn">{{ t('inbox.open') }}</NuxtLink>
          <NuxtLink v-else-if="e.subkind === 'session' && runLink(e)" :to="runLink(e)!" :class="btn">{{ t('inbox.open') }}</NuxtLink>
        </div>
        <PagerBar :total="data.errors.length" :per-page="PER_PAGE" :page="pageOf('errors', data.errors)" @update:page="(p) => pages.errors = p" />
      </div>
    </section>

    <!-- automation notes: what the engine did / why it held back -->
    <section v-if="data?.automation.length" :class="box">
      <div :class="head"><h2 :class="h2">{{ t('inbox.automation') }} ({{ data.automation.length }})</h2><p :class="hint">{{ t('inbox.hint.automation') }}</p></div>
      <div class="px-4 pb-3">
        <div v-for="a in paged('automation', data.automation)" :key="a.id" class="text-xs py-1.5 border-t border-default first:border-t-0 flex gap-2">
          <span class="text-dimmed whitespace-nowrap">{{ when(a.ts) }}</span><span class="text-dimmed">{{ a.projectName }} #{{ a.prNumber }}</span><span class="font-mono">{{ a.kind }}</span><span class="truncate">{{ a.message }}</span>
        </div>
        <PagerBar :total="data.automation.length" :per-page="PER_PAGE" :page="pageOf('automation', data.automation)" @update:page="(p) => pages.automation = p" />
      </div>
    </section>
  </div>
</template>

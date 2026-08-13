<script setup lang="ts">
import type { Project } from '~core/db/schema'
const { data: health } = await useFetch<{ gh: { ok: boolean }; inferenceProvider: string; model: string }>('/api/health')
const { data: projects } = await useFetch<Project[]>('/api/projects')
</script>

<template>
  <div class="max-w-xl mx-auto px-10 py-24">
    <div class="flex items-center gap-3">
      <img src="/logo.svg" alt="" class="w-10 h-10 rounded-lg" />
      <h1 class="text-4xl font-light tracking-tight">PR Cockpit</h1>
    </div>
    <div class="w-10 border-t border-accented my-6" />
    <p class="text-sm text-muted leading-relaxed">
      {{ $t('home.tagline') }}
    </p>

    <div class="mt-14 space-y-0">
      <div class="flex items-center py-4 border-t border-default">
        <span class="text-[10px] uppercase tracking-[0.2em] text-dimmed w-28">gh cli</span>
        <span class="text-sm" :class="health?.gh?.ok ? 'text-highlighted' : 'text-dimmed'">
          {{ health?.gh?.ok ? $t('home.ghStatusOk') : $t('home.ghStatusNotReady') }}
        </span>
      </div>
      <div class="flex items-center py-4 border-t border-default">
        <span class="text-[10px] uppercase tracking-[0.2em] text-dimmed w-28">{{ $t('home.defaultModel') }}</span>
        <span class="text-sm text-highlighted">{{ health?.inferenceProvider }} · {{ health?.model }}</span>
      </div>
      <div class="flex items-center py-4 border-t border-b border-default">
        <span class="text-[10px] uppercase tracking-[0.2em] text-dimmed w-28">{{ $t('layout.projectsTitle') }}</span>
        <span class="text-sm text-highlighted">{{ $t('home.projectsCount', { count: projects?.length || 0 }) }}</span>
      </div>
    </div>

    <div class="mt-12">
      <NuxtLink
        v-if="projects?.length"
        :to="`/projects/${projects[0]!.id}`"
        class="text-sm text-highlighted underline underline-offset-4 hover:text-toned"
      >
        {{ $t('home.enterProject', { name: projects[0]!.name }) }}
      </NuxtLink>
      <p v-else class="text-sm text-dimmed">{{ $t('home.emptyHint') }}</p>
    </div>
  </div>
</template>

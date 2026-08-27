<script setup lang="ts">
// Native prompts from the session host: permission / AskUserQuestion / plan approval. State + actions live in useRunHost.
import type { RunHost } from '../composables/useRunHost'
defineProps<{ host: RunHost }>()
</script>

<template>
  <div v-for="p in host.pending.value" :key="p.id" class="rounded border p-3 space-y-2 text-left" :class="p.kind === 'tool' ? 'border-amber-500/60' : 'border-inverted'">
    <template v-if="p.kind === 'question'">
      <div class="text-[10px] uppercase tracking-[0.15em] text-dimmed">{{ $t('global.questionTitle') }}</div>
      <div v-for="q in (p.input?.questions ?? [])" :key="q.question" class="space-y-1.5">
        <p class="text-sm font-medium whitespace-pre-wrap"><span v-if="q.header" class="text-[10px] uppercase tracking-wider text-dimmed mr-2">{{ q.header }}</span>{{ q.question }}</p>
        <div class="flex flex-col gap-1">
          <button
            v-for="o in (q.options ?? [])" :key="o.label" type="button"
            class="text-left text-sm border rounded px-3 py-1.5 hover:bg-elevated/40"
            :class="host.isPicked(p, q.question, o.label) ? 'border-inverted bg-elevated/40' : 'border-default'"
            @click="host.pickOption(p, q.question, o.label, !!q.multiSelect)"
          >{{ o.label }}<span v-if="o.description" class="block text-xs text-dimmed">{{ o.description }}</span></button>
          <input v-model="host.otherAnswer.value[`${p.id}:${q.question}`]" class="text-sm border border-default rounded px-2 py-1 bg-transparent outline-none focus:border-inverted" :placeholder="$t('global.otherAnswer')" @keydown.enter.prevent="$event.isComposing || host.submitQuestion(p)" />
        </div>
      </div>
      <div class="flex gap-2">
        <button class="text-xs bg-inverted text-inverted px-3 py-1 rounded disabled:opacity-40" :disabled="host.busy.value || !host.questionReady(p)" @click="host.submitQuestion(p)">{{ $t('global.submitAnswer') }}</button>
        <button class="text-xs text-dimmed hover:text-error" :disabled="host.busy.value" @click="host.answerPrompt(p, { behavior: 'deny' })">{{ $t('global.deny') }}</button>
      </div>
    </template>
    <template v-else-if="p.kind === 'plan'">
      <div class="text-[10px] uppercase tracking-[0.15em] text-dimmed">{{ $t('global.planTitle') }}</div>
      <div class="text-sm max-h-72 overflow-y-auto"><MarkdownBody :text="host.planText(p)" /></div>
      <div class="flex flex-wrap gap-2 items-center">
        <button class="text-xs bg-inverted text-inverted px-3 py-1 rounded disabled:opacity-40" :disabled="host.busy.value" @click="host.answerPrompt(p, { behavior: 'allow' })">{{ $t('global.approvePlan') }}</button>
        <button class="text-xs border border-default px-3 py-1 rounded hover:bg-muted" :disabled="host.busy.value" @click="host.denying.value = host.denying.value === p.id ? null : p.id">{{ $t('global.revisePlan') }}</button>
      </div>
      <div v-if="host.denying.value === p.id" class="flex gap-2">
        <input v-model="host.denyNote.value[p.id]" class="flex-1 text-sm border border-default rounded px-2 py-1 bg-transparent outline-none focus:border-inverted" :placeholder="$t('global.denyNotePlaceholder')" @keydown.enter.prevent="$event.isComposing || host.answerPrompt(p, { behavior: 'deny', message: host.denyNote.value[p.id] })" />
        <button class="text-xs text-error border border-default px-3 py-1 rounded" :disabled="host.busy.value" @click="host.answerPrompt(p, { behavior: 'deny', message: host.denyNote.value[p.id] })">{{ $t('global.deny') }}</button>
      </div>
    </template>
    <template v-else>
      <div class="text-[10px] uppercase tracking-[0.15em] text-dimmed">{{ $t('global.permissionTitle') }}</div>
      <p class="text-sm font-medium">{{ p.title || p.toolName }}</p>
      <p v-if="p.description" class="text-xs text-dimmed">{{ p.description }}</p>
      <pre v-if="host.promptPreview(p)" class="text-xs bg-neutral-900 text-neutral-200 rounded p-2 overflow-auto whitespace-pre-wrap max-h-72">{{ host.promptPreview(p) }}</pre>
      <div class="flex flex-wrap gap-2 items-center">
        <button class="text-xs bg-inverted text-inverted px-3 py-1 rounded disabled:opacity-40" :disabled="host.busy.value" @click="host.answerPrompt(p, { behavior: 'allow' })">{{ $t('global.allow') }}</button>
        <button v-if="p.suggestions" class="text-xs border border-default px-3 py-1 rounded hover:bg-muted disabled:opacity-40" :disabled="host.busy.value" @click="host.answerPrompt(p, { behavior: 'allow', always: true })">{{ $t('global.allowAlways') }}</button>
        <button class="text-xs text-error border border-default px-3 py-1 rounded hover:bg-muted disabled:opacity-40" :disabled="host.busy.value" @click="host.answerPrompt(p, { behavior: 'deny' })">{{ $t('global.deny') }}</button>
        <button class="text-xs text-dimmed hover:text-highlighted" :disabled="host.busy.value" @click="host.denying.value = host.denying.value === p.id ? null : p.id">{{ $t('global.denyWithNote') }}</button>
      </div>
      <div v-if="host.denying.value === p.id" class="flex gap-2">
        <input v-model="host.denyNote.value[p.id]" class="flex-1 text-sm border border-default rounded px-2 py-1 bg-transparent outline-none focus:border-inverted" :placeholder="$t('global.denyNotePlaceholder')" @keydown.enter.prevent="$event.isComposing || host.answerPrompt(p, { behavior: 'deny', message: host.denyNote.value[p.id] })" />
        <button class="text-xs text-error border border-default px-3 py-1 rounded" :disabled="host.busy.value" @click="host.answerPrompt(p, { behavior: 'deny', message: host.denyNote.value[p.id] })">{{ $t('global.deny') }}</button>
      </div>
    </template>
  </div>
</template>

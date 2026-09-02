<script setup lang="ts">
// The shared renderer for agent output. The pipeline itself lives in useMarkdown (one loader, shared by every caller);
// this component owns the look, and its .md-body styles are deliberately unscoped so any consumer gets them by mounting
// it — nothing has to be loaded in a particular order.
const props = defineProps<{ text?: string | null; inline?: boolean }>()

// inline: emphasis and code spans without a paragraph wrapper, for titles and other single-line labels.
const html = useMarkdown(() => props.text, { inline: props.inline })
</script>

<template>
  <component :is="inline ? 'span' : 'div'" class="md-body" :class="{ 'md-inline': inline }" v-html="html" />
</template>

<style>
.md-body { font-size: 0.875rem; line-height: 1.65; color: var(--ui-text-toned); word-break: break-word; }
.md-body > *:first-child { margin-top: 0; }
.md-body > *:last-child { margin-bottom: 0; }
.md-body h1, .md-body h2, .md-body h3, .md-body h4 { font-weight: 600; margin: 0.9em 0 0.4em; color: var(--ui-text-highlighted); }
.md-body h1 { font-size: 1.1rem; } .md-body h2 { font-size: 1rem; } .md-body h3 { font-size: 0.92rem; }
.md-body p { margin: 0.5em 0; }
.md-body ul { margin: 0.5em 0; padding-left: 1.3em; list-style: disc; }
.md-body ol { margin: 0.5em 0; padding-left: 1.3em; list-style: decimal; }
.md-body li { margin: 0.2em 0; }
.md-body code { background: var(--ui-bg-muted); padding: 0.1em 0.35em; border-radius: 3px; font-size: 0.85em; }
.md-body pre { background: var(--ui-bg-muted); padding: 0.7em; border-radius: 6px; overflow-x: auto; margin: 0.6em 0; }
.md-body pre code { background: none; padding: 0; }
.md-body a { color: var(--ui-text-highlighted); text-decoration: underline; }
.md-body blockquote { border-left: 2px solid var(--ui-border); padding-left: 0.8em; color: var(--ui-text-muted); margin: 0.5em 0; }
.md-body table { border-collapse: collapse; margin: 0.6em 0; font-size: 0.85em; }
.md-body th, .md-body td { border: 1px solid var(--ui-border); padding: 0.3em 0.6em; text-align: left; }
.md-body img { max-width: 100%; }
/* inline mode: the surrounding line owns the typography, so contribute nothing but emphasis and code spans */
.md-inline { display: inline; font-size: inherit; line-height: inherit; color: inherit; }
.md-inline code { font-size: 0.9em; }
.md-body hr { border: 0; border-top: 1px solid var(--ui-border); margin: 0.8em 0; }
</style>

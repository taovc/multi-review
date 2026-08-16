<script setup lang="ts">
// Shared markdown rendering (for chat/assistant output): marked + dompurify loaded dynamically on the
// client, gfm + breaks.
// The .md-body styles match the review drawer; they ship with this component (not scoped), so nothing
// else has to be mounted first.
const props = defineProps<{ text: string }>()

const html = ref('')
let _render: ((s: string) => string) | null = null
async function getRenderer() {
  if (_render) return _render
  const [{ marked }, dp] = await Promise.all([import('marked'), import('dompurify')])
  marked.setOptions({ gfm: true, breaks: true })
  const DOMPurify = (dp as any).default
  // Private GitHub images go through the backend proxy (same as PrDetailDrawer), so they still render
  // when the AI output references them.
  const PROXY = /(<img[^>]+\bsrc=")(https:\/\/(?:github\.com\/user-attachments\/|[a-z0-9-]+\.githubusercontent\.com\/)[^"]+)(")/gi
  _render = (s: string) => {
    const out = DOMPurify.sanitize(marked.parse(s ?? '', { async: false }) as string)
    return out.replace(PROXY, (_m: string, pre: string, url: string, post: string) => `${pre}/api/img?u=${encodeURIComponent(url)}${post}`)
  }
  return _render
}

// While streaming this re-renders on every token; marked is fast enough. Nothing renders during SSR
// (the dynamic import is client-only).
watch(() => props.text, async (t) => {
  if (!import.meta.client) return
  const render = await getRenderer()
  html.value = render(t || '')
}, { immediate: true })
</script>

<template>
  <div class="md-body" v-html="html" />
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
.md-body hr { border: 0; border-top: 1px solid var(--ui-border); margin: 0.8em 0; }
</style>

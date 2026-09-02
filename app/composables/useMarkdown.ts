import type { MaybeRefOrGetter } from 'vue'

// The one markdown pipeline for agent output. Everything an agent writes — a review's conclusion, a finding's problem
// and fix, a re-review verdict, a chat turn, a PR body — is markdown, and it was being rendered three different ways:
// the assistant had a renderer, the PR drawer had a second copy of the same renderer and the same stylesheet, and the
// review drawer had none at all and printed the source, asterisks and backticks included.
//
// marked + dompurify are loaded on the client only (dompurify needs a DOM) and the loaded module is shared across every
// caller, so the second component to render pays nothing.

type Renderer = { render: (s: string) => string; renderInline: (s: string) => string }

let loading: Promise<Renderer> | null = null

// Private GitHub attachments are not fetchable from the browser: route them through the backend proxy so images in an
// agent's output (or a PR body it quotes) actually appear.
const PROXY = /(<img[^>]+\bsrc=")(https:\/\/(?:github\.com\/user-attachments\/|[a-z0-9-]+\.githubusercontent\.com\/)[^"]+)(")/gi
const proxyImages = (html: string) =>
  html.replace(PROXY, (_m, pre: string, url: string, post: string) => `${pre}/api/img?u=${encodeURIComponent(url)}${post}`)

export function loadMarkdownRenderer(): Promise<Renderer> {
  if (!loading) {
    loading = Promise.all([import('marked'), import('dompurify')]).then(([{ marked }, dp]) => {
      marked.setOptions({ gfm: true, breaks: true })
      const DOMPurify = (dp as any).default
      return {
        render: (s: string) => proxyImages(DOMPurify.sanitize(marked.parse(s ?? '', { async: false }) as string)),
        // Titles and other single-line labels: emphasis and code spans, no paragraph wrapper to break the layout.
        renderInline: (s: string) => proxyImages(DOMPurify.sanitize(marked.parseInline(s ?? '', { async: false }) as string)),
      }
    })
  }
  return loading
}

// Reactive HTML for a piece of agent text. Re-renders as the text grows, which is what streaming needs; marked is fast
// enough to run per token. Stays empty during SSR — nothing here can run without a DOM.
export function useMarkdown(text: MaybeRefOrGetter<string | null | undefined>, opts: { inline?: boolean } = {}) {
  const html = ref('')
  watch(
    () => toValue(text),
    async (t) => {
      if (!import.meta.client) return
      const r = await loadMarkdownRenderer()
      html.value = opts.inline ? r.renderInline(t || '') : r.render(t || '')
    },
    { immediate: true },
  )
  return html
}

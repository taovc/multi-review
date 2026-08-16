// "Scroll to bottom" for chat/log areas: several drawers each carried their own copy of the same scrollEl + nextTick scrolling.
// Consumers bind scrollEl to their scroll container and decide when to call scrollToBottom (each drawer triggers on different conditions, so it stays configurable).
export function useScrollToBottom() {
  const scrollEl = ref<HTMLElement | null>(null)
  function scrollToBottom() {
    // A single nextTick often doesn't reach the real bottom: MarkdownBody renders asynchronously (dynamic import of marked/dompurify),
    // so on the first jump the content height hasn't grown yet. Add two rAF frames + one timeout, letting async rendering / images / plan cards fill out the height before scrolling.
    const go = () => { const el = scrollEl.value; if (el) el.scrollTop = el.scrollHeight }
    nextTick(() => {
      go()
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => { go(); requestAnimationFrame(go) })
      }
      setTimeout(go, 120)
    })
  }
  return { scrollEl, scrollToBottom }
}

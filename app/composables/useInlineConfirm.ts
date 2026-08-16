// Inline confirmation inside a drawer (no popup — a modal on top of a drawer cannot be interacted with,
// which is a hard constraint in this project).
// A single string state records "which action is being confirmed" ('' = none); the delete/discard actions
// in fix/global/feature all use this pattern.
export function useInlineConfirm() {
  const confirming = ref('')
  return {
    confirming,
    ask: (key: string) => { confirming.value = key },
    cancel: () => { confirming.value = '' },
    is: (key: string) => confirming.value === key,
  }
}

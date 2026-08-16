import { reactive } from 'vue'

type ConfirmOpts = { title?: string; message: string; okText?: string; cancelText?: string; danger?: boolean }

// Global singleton confirm-dialog state (rendered by <AppConfirm/>, triggered by useConfirm()).
// Replaces the native window.confirm.
// When title/okText/cancelText are left empty, <AppConfirm/> falls back to the i18n defaults (so the copy
// follows the language switch, and it can be triggered outside of setup)
export const confirmState = reactive({
  open: false,
  title: '',
  message: '',
  okText: '',
  cancelText: '',
  danger: false,
  _resolve: null as null | ((v: boolean) => void),
})

export function useConfirm() {
  return (opts: ConfirmOpts) =>
    new Promise<boolean>((resolve) => {
      confirmState.title = opts.title ?? ''
      confirmState.message = opts.message
      confirmState.okText = opts.okText ?? ''
      confirmState.cancelText = opts.cancelText ?? ''
      confirmState.danger = !!opts.danger
      confirmState._resolve = resolve
      confirmState.open = true
    })
}

export function resolveConfirm(v: boolean) {
  confirmState.open = false
  confirmState._resolve?.(v)
  confirmState._resolve = null
}

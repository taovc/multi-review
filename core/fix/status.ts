// Deciding a fix task's "next status": unuploaded changes (dirty locally or ahead of the remote) → ready; otherwise stay pushed, or fall back to open.
// This rule used to be written twice, in core/fix/pipeline.ts and server/api/fixes/[id].get.ts, which drifts easily — extracted into a single source.
export function computeFixNextStatus(args: {
  dirty: boolean
  ahead: boolean
  currentStatus?: string | null
}): 'ready' | 'pushed' | 'open' {
  if (args.dirty || args.ahead) return 'ready'
  return args.currentStatus === 'pushed' ? 'pushed' : 'open'
}

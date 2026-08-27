// Stop handles for running review-family jobs, keyed by review id (the pipeline registers one per job; the stop
// endpoint aborts it, which makes the SDK query throw and the job end in `error` with a "stopped" message).
export const reviewAborts = new Map<string, AbortController>()

export function stopReview(reviewId: string): boolean {
  const a = reviewAborts.get(reviewId)
  if (!a) return false
  a.abort(new Error('stopped by the user'))
  return true
}

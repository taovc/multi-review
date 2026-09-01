import type { ReviewAgentOptions, ReviewResult } from './review'
import type { RecheckAgentOptions, RecheckResult } from './recheck'
import type { ProviderUsage } from '../runs/types'

export type ReviewProvider = 'claude' | 'codex'

// usage: tokens / per-model cost / duration for the run record (null when the provider gave nothing usable).
export interface ReviewRunner {
  runReview(opts: ReviewAgentOptions): Promise<{ result: ReviewResult; costUsd: number; raw: string; usage: ProviderUsage | null }>
  runRecheck(opts: RecheckAgentOptions): Promise<{ result: RecheckResult; costUsd: number; usage: ProviderUsage | null }>
}

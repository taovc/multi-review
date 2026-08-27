import { runGuidedReviewAgent, runReviewAgent } from './review'
import { runRecheckAgent } from './recheck'
import type { ReviewRunner } from './runners'

export const claudeReviewRunner: ReviewRunner = {
  runReview: runReviewAgent,
  runGuidedReview: runGuidedReviewAgent,
  runRecheck: runRecheckAgent,
}

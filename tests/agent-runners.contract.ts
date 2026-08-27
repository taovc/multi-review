import type { ReviewRunner } from '../core/agent/runners'
import { claudeReviewRunner } from '../core/agent/claudeRunners'
import { codexReviewRunner } from '../core/agent/codexReview'
import type { SessionHost } from '../core/host/types'
import { claudeHost, codexHost } from '../core/host'

// Reviews still have one runner per provider; chats have none — both providers implement the session host contract.
const reviewRunner: ReviewRunner = claudeReviewRunner
const codexRunner: ReviewRunner = codexReviewRunner
const hosts: SessionHost[] = [claudeHost, codexHost]

void reviewRunner
void codexRunner
void hosts

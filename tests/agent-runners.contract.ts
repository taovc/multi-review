import type { ChatRunner, ReviewRunner } from '../core/agent/runners'
import { claudeChatRunner, claudeReviewRunner } from '../core/agent/claudeRunners'
import { codexReviewRunner } from '../core/agent/codexReview'
import type { SessionHost } from '../core/host/types'
import { claudeHost, codexHost } from '../core/host'

const reviewRunner: ReviewRunner = claudeReviewRunner
const chatRunner: ChatRunner = claudeChatRunner
const codexRunner: ReviewRunner = codexReviewRunner
// Chats no longer have a runner per provider: both providers implement the session host contract.
const hosts: SessionHost[] = [claudeHost, codexHost]

void reviewRunner
void chatRunner
void codexRunner
void hosts

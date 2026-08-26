import { inboxOverview } from '~core/inbox/queries'

// "What is waiting for me": pending prompts, draft reviews to triage, author updates, recent errors, automation notes.
export default defineEventHandler(() => {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString()
  return inboxOverview(db(), { sinceIso: since })
})

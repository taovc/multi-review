import { claudeHost } from '~core/host/claudeHost'

// Interrupt the current turn (like Esc in the CLI). The session stays live; text produced so far is kept.
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const ok = await claudeHost.interrupt(id)
  return { ok }
})

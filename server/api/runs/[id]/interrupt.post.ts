import { hostOf } from '~core/host'

// Interrupt the current turn (like Esc in the CLI). The session stays live; text produced so far is kept.
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const ok = await hostOf(id).interrupt(id)
  return { ok }
})

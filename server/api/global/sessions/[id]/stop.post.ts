import { stopGlobalChat } from '~core/global/pipeline'

// Stop the current generation turn: send SIGINT to the detached process group (same as Ctrl+C). Text already generated is kept.
export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')!
  const ok = stopGlobalChat(id)
  return { ok, stopped: ok }
})

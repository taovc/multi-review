import { stopFeatureImpl } from '~core/feature/pipeline'

// Stop the current develop turn (single-phase): codex uses the abort handle the runner exposes;
// claude gets SIGINT→SIGKILL on its child process group.
// Returns false when nothing is running (no handle and no child process).
export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')!
  const ok = stopFeatureImpl(id)
  return { ok, stopped: ok }
})

import { stopFeatureImpl } from '~core/feature/pipeline'

// 停止阶段2 实现轮（阶段1 是 SDK 只读分析，不可中途停，跟 review 一致）。
export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')!
  const ok = stopFeatureImpl(id)
  return { ok, stopped: ok }
})

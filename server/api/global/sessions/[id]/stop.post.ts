import { stopGlobalChat } from '~core/global/pipeline'

// 停止当前生成轮：detached 进程组发 SIGINT（等同 Ctrl+C）。已生成文本保留。
export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')!
  const ok = stopGlobalChat(id)
  return { ok, stopped: ok }
})

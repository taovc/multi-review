import { stopAllGlobalChats } from '~core/global/pipeline'
import { stopAllFixChats } from '~core/fix/pipeline'
import { stopAllFeatureImpl } from '~core/feature/pipeline'

// Graceful exit: Electron sends Nitro a SIGTERM when the app closes (see stopNitro in electron/main.mjs).
// Running claude/codex agents are spawned detached in their own process groups, so killing the Nitro
// parent never reaches them — we must stop each process group here, otherwise agents keep running in
// the background after exit (burning tokens, possibly even pushing).
//
// Each stop synchronously sends SIGINT to the process group (same as Ctrl+C) and schedules a 1.5s
// SIGKILL backstop. We give those backstops a moment before exiting; if nothing is running we exit
// immediately.
// SIGTERM only: dev is stopped with Ctrl+C (SIGINT), which we stay out of.
export default defineNitroPlugin(() => {
  let stopping = false

  const reapAndExit = () => {
    if (stopping) return
    stopping = true

    let any = false
    for (const stopAll of [stopAllGlobalChats, stopAllFixChats, stopAllFeatureImpl]) {
      try {
        if (stopAll()) any = true
      } catch (err) {
        console.error('[shutdown] stopAll failed:', err)
      }
    }

    // Agents running → wait 1.8s so the 1.5s SIGKILL backstop fires first (still inside Electron's
    // 3s force-kill window); nothing running → exit immediately.
    setTimeout(() => process.exit(0), any ? 1800 : 0)
  }

  process.once('SIGTERM', reapAndExit)
})

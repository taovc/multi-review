import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'

// 启一个项目 dev server（UI 校验用，best-effort）。stakimo-app 需要 env/DB，
// 起不来就抛错，由上层降级跳过 UI 校验。进程组方式启动，方便整组精确 kill（不用 pkill）。
export type DevServer = { url: string; stop: () => void }

function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve) => {
    const tryOnce = () => {
      const sock = net.connect({ host: '127.0.0.1', port }, () => {
        sock.destroy()
        resolve(true)
      })
      sock.on('error', () => {
        sock.destroy()
        if (Date.now() > deadline) resolve(false)
        else setTimeout(tryOnce, 700)
      })
    }
    tryOnce()
  })
}

function stopTree(cp: ChildProcess) {
  if (cp.pid == null) return
  try {
    process.kill(-cp.pid, 'SIGTERM') // 杀整个进程组（detached 启的）
  } catch {
    try {
      cp.kill('SIGTERM')
    } catch {
      /* ignore */
    }
  }
}

export async function startDevServer(opts: {
  cwd: string
  port: number
  timeoutMs?: number
  onLog?: (m: string) => void
}): Promise<DevServer> {
  const { cwd, port, onLog } = opts
  const cp = spawn('pnpm', ['dev'], {
    cwd,
    detached: true,
    env: { ...process.env, PORT: String(port), NUXT_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  cp.stdout?.on('data', (d) => onLog?.(String(d).slice(0, 160)))
  cp.stderr?.on('data', (d) => onLog?.(String(d).slice(0, 160)))

  const ok = await waitForPort(port, opts.timeoutMs ?? 120_000)
  if (!ok) {
    stopTree(cp)
    throw new Error(`dev server n'a pas démarré sur le port ${port}`)
  }
  return { url: `http://127.0.0.1:${port}`, stop: () => stopTree(cp) }
}

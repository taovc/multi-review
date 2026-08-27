import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { z } from 'zod'
import { getRunOr404 } from '../../../utils/runContext'

// Open the session's workspace in an editor / terminal / file manager on the machine that runs the server.
const Body = z.object({ app: z.enum(['vscode', 'cursor', 'terminal', 'finder']) })

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const { app } = Body.parse((await readBody(event)) || {})
  const run = getRunOr404(id)
  const path = run.workspacePath
  if (!path || !existsSync(path)) throw createError({ statusCode: 400, statusMessage: '工作目录不存在' })
  const mac = process.platform === 'darwin'
  const cmd: [string, string[]] =
    app === 'vscode' ? ['code', [path]]
    : app === 'cursor' ? ['cursor', [path]]
    : app === 'terminal' ? (mac ? ['open', ['-a', 'Terminal', path]] : ['x-terminal-emulator', ['--working-directory', path]])
    : (mac ? ['open', [path]] : ['xdg-open', [path]])
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' })
    child.once('error', (e) => reject(createError({ statusCode: 500, statusMessage: `无法启动 ${cmd[0]}: ${e.message}` })))
    child.once('spawn', () => { child.unref(); resolve() })
  })
  return { ok: true, app, path }
})

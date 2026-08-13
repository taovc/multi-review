import { app, BrowserWindow, shell, dialog, Menu, ipcMain } from 'electron'
import path from 'node:path'
import net from 'node:net'
import fs from 'node:fs'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { checkForUpdates, setUpdaterLocale } from './updater.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let didAutoCheckUpdates = false // 启动只自动查一次更新(重开窗口不重复弹)

// dev 模式由启动脚本注入(指向 nuxt dev server)。打包态忽略该 env：
// 否则任何能设置启动环境的人都能把「可信」app 悄悄重定向到任意 URL 并自动开 DevTools。
const DEV_URL = app.isPackaged ? '' : process.env.ELECTRON_RENDERER_URL || ''
// Nitro 绑 0.0.0.0（所有网卡），让局域网设备「有可能」连上；到底放不放行由
// server/middleware/00.lan-guard.ts 按请求鉴权（默认关闭、远端 403）。桌面窗口
// 始终走回环地址，与远程访问开关无关。
const BIND_HOST = '0.0.0.0'
const LOOPBACK = '127.0.0.1'

let mainWindow = null
let serverProc = null
let serverUrl = '' // 已起的 Nitro 地址(打包态)；重开窗口时复用
let lastStderr = '' // Nitro 最近的 stderr，启动失败时显示给用户
let startPromise = null // 进行中的 startNitro()，冷启动期间重入时复用,避免双开 Nitro
let openingPromise = null // 进行中的 openMainWindow()，避免并发重入双开窗口

// macOS/Linux GUI 启动的 app 不继承登录 shell 的 PATH,会导致子进程找不到
// git / gh / claude / codex / node。用登录 shell 取一次真实 PATH 注入。
function resolveShellPath() {
  const common = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
  const merge = (p) => {
    const parts = (p || '').split(path.delimiter).filter(Boolean)
    for (const c of common) if (!parts.includes(c)) parts.push(c)
    return parts.join(path.delimiter)
  }
  if (process.platform === 'win32') return process.env.PATH
  try {
    const shellBin = process.env.SHELL || '/bin/zsh'
    const out = execFileSync(shellBin, ['-lic', 'printf "__MR_PATH__:%s" "$PATH"'], {
      timeout: 5000,
      encoding: 'utf8',
    })
    const m = out.match(/__MR_PATH__:(.*)/)
    return merge(m ? m[1].trim() : process.env.PATH)
  } catch {
    return merge(process.env.PATH)
  }
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, BIND_HOST, () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

// 轮询端口直到 server 就绪；同时盯着子进程的 error/exit。一旦 Nitro 启动就崩
// (better-sqlite3 ABI 不匹配 / ensureSchema 抛错 / DB 锁 / 端口被抢 / spawn ENOENT)
// 立刻 reject，不再傻等满 30s，并把退出码 + 最近 stderr 带进错误信息。
function waitForServer(port, child, timeoutMs = 30000) {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    let settled = false
    const tail = () => (lastStderr.trim() ? `\n\n${lastStderr.trim()}` : '')
    const done = (fn, arg) => {
      if (settled) return
      settled = true
      fn(arg)
    }
    child.once('error', (err) => done(reject, new Error(`Failed to launch Nitro server: ${err.message}`)))
    child.once('exit', (code, signal) =>
      done(reject, new Error(`Nitro server exited before it was ready (code ${code ?? signal}).${tail()}`)))
    const tryonce = () => {
      if (settled) return
      const sock = net.connect(port, LOOPBACK)
      sock.once('connect', () => {
        sock.destroy()
        done(resolve)
      })
      sock.once('error', () => {
        sock.destroy()
        if (settled) return
        if (Date.now() - start > timeoutMs) {
          done(reject, new Error(`Server not ready on ${LOOPBACK}:${port} after ${timeoutMs}ms.${tail()}`))
        } else {
          setTimeout(tryonce, 250)
        }
      })
    }
    tryonce()
  })
}

async function startNitro() {
  const outputDir = app.isPackaged
    ? path.join(process.resourcesPath, '.output')
    : path.join(__dirname, '..', '.output')
  const serverEntry = path.join(outputDir, 'server', 'index.mjs')

  const envPath = resolveShellPath()
  const port = await getFreePort()
  const userData = app.getPath('userData')
  fs.mkdirSync(userData, { recursive: true }) // 作为子进程 cwd，确保首次启动时存在
  lastStderr = ''

  // 用 Electron 自带的 node 跑 Nitro(ELECTRON_RUN_AS_NODE),不依赖用户系统装没装 node、
  // 装的哪个版本。better-sqlite3 在打包时已按 Electron 的 ABI 预编译(scripts/prepare-electron-sqlite)。
  // DB / worktrees 用 NUXT_ 前缀覆盖 runtimeConfig —— Nitro 运行时只认 NUXT_*，
  // 旧的 DB_PATH/REPOS_DIR 是 no-op；这里给绝对路径，不依赖 cwd。
  const child = spawn(process.execPath, [serverEntry], {
    cwd: userData,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PATH: envPath,
      NITRO_HOST: BIND_HOST,
      HOST: BIND_HOST,
      NITRO_PORT: String(port),
      PORT: String(port),
      NUXT_DB_PATH: path.join(userData, 'cockpit.db'),
      NUXT_REPOS_DIR: path.join(userData, 'worktrees'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  serverProc = child
  child.stdout.on('data', (d) => process.stdout.write(`[nitro] ${d}`))
  child.stderr.on('data', (d) => {
    process.stderr.write(`[nitro] ${d}`)
    lastStderr = (lastStderr + d).slice(-2000)
  })
  // 常驻 error 处理：spawn 失败(ENOENT/EMFILE 等)不会冒泡成 uncaughtException 崩主进程
  child.on('error', (err) => {
    if (serverProc === child) serverProc = null
    console.error('[nitro] process error:', err.message)
  })
  child.on('exit', (code) => {
    if (serverProc === child) serverProc = null
    if (code && code !== 0) console.error(`[nitro] exited with code ${code}`)
  })

  await waitForServer(port, child)
  serverUrl = `http://${LOOPBACK}:${port}`
  return serverUrl
}

// 要加载的 URL：dev 用注入的；打包态复用已起的 Nitro，没起或已死则(重新)启动。
async function resolveAppUrl() {
  if (DEV_URL) return DEV_URL
  if (serverProc && serverUrl) return serverUrl
  // serverUrl 要等 waitForServer(几秒)才赋值,但 serverProc 在 spawn 时就有 —— 冷启动
  // 窗口里 `serverProc && serverUrl` 仍是 false。若此时重入(macOS 首次启动的 activate)
  // 会再 startNitro 一次,两个 Nitro 打在同一个 userData DB/worktrees 上。用进行中的
  // promise 兜住,整个启动期只会有一个 startNitro。
  if (!startPromise) {
    startPromise = startNitro().finally(() => {
      startPromise = null
    })
  }
  return await startPromise
}

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 720,
    title: 'PR Cockpit',
    // macOS：隐藏原生标题栏，traffic light 嵌进 app 自己的顶栏(h-16=64px)垂直居中
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 18, y: 24 } }
      : {}),
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'), // 暴露 window.mrUpdates.check()
    },
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  const appOrigin = new URL(url).origin
  const isExternal = (target) => {
    try {
      const u = new URL(target)
      return (u.protocol === 'http:' || u.protocol === 'https:') && u.origin !== appOrigin
    } catch {
      return false
    }
  }

  // target="_blank" / window.open 触发的新窗口:外部站点走系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (isExternal(target)) shell.openExternal(target)
    return { action: 'deny' }
  })

  // 普通 <a href> 是同窗口导航(will-navigate),会把整个 app 导航走。
  // 指向外部站点的链接拦下来交给系统浏览器,app 自身的导航放行。
  mainWindow.webContents.on('will-navigate', (event, target) => {
    if (isExternal(target)) {
      event.preventDefault()
      shell.openExternal(target)
    }
  })

  mainWindow.loadURL(url)
  if (DEV_URL) mainWindow.webContents.openDevTools({ mode: 'detach' })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function stopNitro() {
  const child = serverProc
  if (!child) return
  serverProc = null
  try {
    // SIGTERM → Nitro 的 shutdown 插件(server/plugins/shutdown.ts)拦下来,先把在跑的
    // claude/codex agent 进程组逐个停掉(它们是 detached 起的,独立进程组,kill 父进程到不了),
    // 再退出。SIGKILL 只是兜底:3s 还没退就强杀 Nitro 本身。
    // 注意:SIGKILL 杀的只是 Nitro 的 pid,杀不到孙进程 —— 真正回收 agent 靠的是上面的 SIGTERM 优雅退出。
    child.kill('SIGTERM')
    const t = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
    }, 3000)
    if (typeof t.unref === 'function') t.unref()
    child.once('exit', () => clearTimeout(t))
  } catch {
    /* ignore */
  }
}

async function openMainWindow() {
  if (mainWindow) {
    mainWindow.focus()
    return
  }
  // 并发重入(whenReady 还在 await resolveAppUrl 时 activate 又触发一次):复用同一个
  // promise,且 await 之后再查一次 mainWindow,确保只建一个窗口。
  if (openingPromise) return openingPromise
  openingPromise = (async () => {
    const url = await resolveAppUrl()
    if (mainWindow) {
      mainWindow.focus()
      return
    }
    createWindow(url)
  })().finally(() => {
    openingPromise = null
  })
  return openingPromise
}

// 应用菜单：保留各平台标准项，额外挂一个「检查更新…」入口(手动触发,非 silent)。
function setupAppMenu() {
  const isMac = process.platform === 'darwin'
  const checkItem = {
    label: isMac ? 'Check for Updates…' : 'Check for Updates',
    click: () => checkForUpdates(mainWindow, { silent: false }),
  }
  const template = [
    ...(isMac
      ? [{ label: app.name, submenu: [{ role: 'about' }, checkItem, { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] }]
      : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        ...(isMac ? [] : [checkItem, { type: 'separator' }]),
        { label: 'PR Cockpit on GitHub', click: () => shell.openExternal('https://github.com/taovc/pr-cockpit') },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// 启动后台静默查一次更新(仅打包态；开发/首窗失败时不打扰)。
function maybeAutoCheckUpdates() {
  if (didAutoCheckUpdates || !app.isPackaged) return
  didAutoCheckUpdates = true
  const t = setTimeout(() => checkForUpdates(mainWindow, { silent: true }), 3000)
  if (typeof t.unref === 'function') t.unref()
}

// 单实例锁：随机端口去掉了旧固定端口的 EADDRINUSE 天然单例保护。两个实例会共用同一个
// userData(DB + worktrees)→ worktree 操作跨进程 race(repoLocks 只在进程内)。
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  // 渲染进程把 app 内选择的语言推来 → 原生更新对话框用它(而非系统语言)。
  ipcMain.on('updates:locale', (_e, locale) => setUpdaterLocale(locale))
  // 顶栏「检查更新」按钮 → 渲染进程通过 preload 桥调这里(手动、非 silent)。
  ipcMain.handle('updates:check', (_e, locale) => checkForUpdates(mainWindow, { silent: false, locale }))

  app.whenReady().then(async () => {
    setupAppMenu()
    try {
      await openMainWindow()
      maybeAutoCheckUpdates()
    } catch (err) {
      console.error('[main] failed to start:', err)
      dialog.showErrorBox('PR Cockpit — startup failed', String(err?.message || err))
      app.quit()
    }
  })

  // macOS：dock 点击 / 重新激活。窗口全关后 app 仍在跑(Nitro 保持热)，
  // 这里从已起的 server 重建窗口；若 Nitro 已死则重启。
  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length > 0) return
    try {
      await openMainWindow()
    } catch (err) {
      console.error('[main] failed to reopen:', err)
      dialog.showErrorBox('PR Cockpit — failed to reopen', String(err?.message || err))
    }
  })

  // 非 macOS：关掉所有窗口即退出(→ before-quit → stopNitro)。
  // macOS：保持 app + Nitro 存活，等 dock 重开或 Cmd+Q。
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', stopNitro)
  process.on('exit', stopNitro)
}

import { app, BrowserWindow, shell, dialog, Menu, ipcMain } from 'electron'
import path from 'node:path'
import net from 'node:net'
import fs from 'node:fs'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { checkForUpdates, setUpdaterLocale } from './updater.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let didAutoCheckUpdates = false // auto-check for updates only once per launch (reopening the window doesn't pop it again)

// Injected by the launch script in dev mode (points at the nuxt dev server). Ignored when packaged:
// otherwise anyone who can set the launch environment could silently redirect the "trusted" app to any URL and auto-open DevTools.
const DEV_URL = app.isPackaged ? '' : process.env.ELECTRON_RENDERER_URL || ''
// Nitro binds 0.0.0.0 (all interfaces) so LAN devices *can* reach it; whether a request is
// actually let through is decided per request by server/middleware/00.lan-guard.ts (off by
// default, remote gets 403). The desktop window always uses the loopback address, independent
// of the remote-access switch.
const BIND_HOST = '0.0.0.0'
const LOOPBACK = '127.0.0.1'

let mainWindow = null
let serverProc = null
let serverUrl = '' // address of the running Nitro (packaged mode); reused when reopening the window
let lastStderr = '' // Nitro's latest stderr, shown to the user when startup fails
let startPromise = null // in-flight startNitro(), reused on re-entry during cold start to avoid starting two Nitros
let openingPromise = null // in-flight openMainWindow(), keeps concurrent re-entry from opening two windows

// An app launched from the GUI on macOS/Linux doesn't inherit the login shell's PATH, so child
// processes can't find git / gh / claude / codex / node. Read the real PATH once from a login shell and inject it.
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

// Poll the port until the server is ready, while watching the child process for error/exit. If
// Nitro crashes right after launch (better-sqlite3 ABI mismatch / ensureSchema throwing / DB lock /
// port taken / spawn ENOENT), reject immediately instead of waiting out the full 30s, and put the
// exit code + latest stderr into the error message.
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
  fs.mkdirSync(userData, { recursive: true }) // used as the child process cwd, make sure it exists on first launch
  lastStderr = ''

  // Run Nitro with Electron's bundled node (ELECTRON_RUN_AS_NODE), so it doesn't depend on whether
  // the user has node installed, or which version. better-sqlite3 is prebuilt against Electron's ABI at package time (scripts/prepare-electron-sqlite).
  // DB / worktrees override runtimeConfig through the NUXT_ prefix — the Nitro runtime only honors
  // NUXT_*, the old DB_PATH/REPOS_DIR are no-ops; absolute paths here, so nothing depends on cwd.
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
  // Permanent error handler: a spawn failure (ENOENT/EMFILE etc.) won't bubble up as an uncaughtException and crash the main process
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

// URL to load: in dev the injected one; when packaged, reuse the running Nitro and (re)start it if it isn't running or has died.
async function resolveAppUrl() {
  if (DEV_URL) return DEV_URL
  if (serverProc && serverUrl) return serverUrl
  // serverUrl is only assigned after waitForServer (a few seconds), but serverProc exists as soon
  // as we spawn — during the cold-start window `serverProc && serverUrl` is still false. Re-entering
  // here (the activate on macOS's first launch) would call startNitro a second time, pointing two
  // Nitros at the same userData DB/worktrees. The in-flight promise catches that, so there's only
  // ever one startNitro for the whole startup.
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
    // macOS: hide the native title bar, the traffic lights sit vertically centered in the app's own top bar (h-16=64px)
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 18, y: 24 } }
      : {}),
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'), // exposes window.mrUpdates.check()
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

  // New windows from target="_blank" / window.open: external sites go to the system browser
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (isExternal(target)) shell.openExternal(target)
    return { action: 'deny' }
  })

  // A plain <a href> is a same-window navigation (will-navigate) and would navigate the whole app away.
  // Intercept links pointing at external sites and hand them to the system browser, let the app's own navigation through.
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
    // SIGTERM → Nitro's shutdown plugin (server/plugins/shutdown.ts) catches it, stops each running
    // claude/codex agent process group one by one (they're spawned detached, in their own process
    // groups, so killing the parent doesn't reach them), then exits. SIGKILL is only a fallback:
    // force-kill Nitro itself if it hasn't exited after 3s.
    // Note: SIGKILL only kills Nitro's own pid, it can't reach grandchildren — agents are actually reclaimed by the graceful SIGTERM exit above.
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
  // Concurrent re-entry (activate fires again while whenReady is still awaiting resolveAppUrl):
  // reuse the same promise, and re-check mainWindow after the await, so only one window is created.
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

// App menu: keep each platform's standard items, plus a "Check for Updates…" entry (manual trigger, not silent).
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

// Silently check for updates once in the background after startup (packaged only; stays out of the way in dev / when the first window fails).
function maybeAutoCheckUpdates() {
  if (didAutoCheckUpdates || !app.isPackaged) return
  didAutoCheckUpdates = true
  const t = setTimeout(() => checkForUpdates(mainWindow, { silent: true }), 3000)
  if (typeof t.unref === 'function') t.unref()
}

// Single-instance lock: the random port dropped the natural single-instance protection the old
// fixed port got from EADDRINUSE. Two instances would share the same userData (DB + worktrees)
// → worktree operations race across processes (repoLocks are per-process only).
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  // The renderer pushes the language chosen inside the app → the native update dialog uses it (not the system language).
  ipcMain.on('updates:locale', (_e, locale) => setUpdaterLocale(locale))
  // Top-bar "Check for updates" button → the renderer calls in here through the preload bridge (manual, not silent).
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

  // macOS: dock click / reactivate. The app keeps running once every window is closed (Nitro stays
  // warm), so rebuild the window from the running server here; restart Nitro if it has died.
  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length > 0) return
    try {
      await openMainWindow()
    } catch (err) {
      console.error('[main] failed to reopen:', err)
      dialog.showErrorBox('PR Cockpit — failed to reopen', String(err?.message || err))
    }
  })

  // Non-macOS: closing all windows quits (→ before-quit → stopNitro).
  // macOS: keep the app + Nitro alive, waiting for a dock reopen or Cmd+Q.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', stopNitro)
  process.on('exit', stopNitro)
}

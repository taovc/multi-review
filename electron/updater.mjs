// 轻量自动更新(方案 A):检测 nightly 是否有更新的构建 → 下载安装包 → 打开引导安装。
// 不做静默替换:macOS 上 Squirrel 要求签名+公证,未签名的 app 无法 apply 更新;
// 这里下载好后打开 DMG/安装包,由用户拖进 Applications。以后配好签名可平滑升级到
// electron-updater 的 quitAndInstall()。
import { app, dialog, shell, net } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { computeUpdate } from './updateLogic.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 更新源:上游的滚动 nightly 预发布(固定地址、带各平台安装包)。可用 env 覆盖。
const UPDATE_REPO = process.env.PRC_UPDATE_REPO || process.env.MR_UPDATE_REPO || 'taovc/pr-cockpit'
const RELEASE_TAG = process.env.PRC_UPDATE_TAG || process.env.MR_UPDATE_TAG || 'nightly'

// 主进程没有 vue-i18n,用系统语言挑一份对话框文案。
const STRINGS = {
  zh: {
    available_title: '发现新版本',
    available_detail: (r, o) => `有更新的构建可用。\n\n远端:${r}\n当前:${o}\n\n下载后请把 app 拖进「应用程序」完成更新。`,
    download: '下载并打开',
    later: '稍后',
    viewPage: '查看发布页',
    uptodate_title: '已是最新',
    uptodate_detail: '当前已是最新的构建。',
    downloaded_title: '下载完成',
    downloaded_detail: (name) => `已下载 ${name}。\n将打开安装包,请把 PR Cockpit 拖进「应用程序」覆盖旧版本。`,
    reveal: '在访达中显示',
    ok: '好的',
    failed_title: '检查更新失败',
    dev_detail: '开发模式不检查更新。',
  },
  en: {
    available_title: 'Update available',
    available_detail: (r, o) => `A newer build is available.\n\nRemote: ${r}\nCurrent: ${o}\n\nAfter download, drag the app into Applications to update.`,
    download: 'Download & open',
    later: 'Later',
    viewPage: 'Release page',
    uptodate_title: 'Up to date',
    uptodate_detail: 'You are running the latest build.',
    downloaded_title: 'Download complete',
    downloaded_detail: (name) => `Downloaded ${name}.\nThe installer will open — drag PR Cockpit into Applications to replace the old version.`,
    reveal: 'Show in Finder',
    ok: 'OK',
    failed_title: 'Update check failed',
    dev_detail: 'Update checks are disabled in dev mode.',
  },
  fr: {
    available_title: 'Mise à jour disponible',
    available_detail: (r, o) => `Une nouvelle version est disponible.\n\nDistante : ${r}\nActuelle : ${o}\n\nAprès téléchargement, glissez l’app dans Applications pour mettre à jour.`,
    download: 'Télécharger et ouvrir',
    later: 'Plus tard',
    viewPage: 'Page de version',
    uptodate_title: 'À jour',
    uptodate_detail: 'Vous utilisez la dernière version.',
    downloaded_title: 'Téléchargement terminé',
    downloaded_detail: (name) => `${name} téléchargé.\nL’installateur va s’ouvrir — glissez PR Cockpit dans Applications pour remplacer l’ancienne version.`,
    reveal: 'Afficher dans le Finder',
    ok: 'OK',
    failed_title: 'Échec de la vérification',
    dev_detail: 'Vérification des mises à jour désactivée en mode dev.',
  },
}

// 对话框语言跟 app 内选择的语言(渲染进程通过 IPC 推来);取不到再回退系统语言。
let uiLocale = null
export function setUpdaterLocale(loc) {
  if (typeof loc === 'string' && loc) uiLocale = loc
}

function tr() {
  const loc = (uiLocale || app.getLocale() || 'en').toLowerCase()
  return loc.startsWith('zh') ? STRINGS.zh : loc.startsWith('fr') ? STRINGS.fr : STRINGS.en
}

function readBuildInfo() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'build-info.json'), 'utf8'))
  } catch {
    return null
  }
}

// electron 的 net(走系统代理),返回解析后的 JSON。跟随重定向。
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = net.request({ url, redirect: 'follow' })
    req.setHeader('Accept', 'application/vnd.github+json')
    req.setHeader('User-Agent', 'PRCockpit-Updater')
    req.on('response', (res) => {
      if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
        res.on('data', () => {})
        res.on('end', () => reject(new Error(`HTTP ${res.statusCode} for ${url}`)))
        return
      }
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch (e) {
          reject(e)
        }
      })
      // 响应头已到、body 中途断流:pipe/end 都不会触发,必须显式 reject,否则 Promise 永挂。
      res.on('error', reject)
      res.on('aborted', () => reject(new Error(`Response aborted for ${url}`)))
    })
    req.on('error', reject)
    req.end()
  })
}

// 流式下载到「下载」目录，用 dock/taskbar 进度条反馈；完成后打开安装包。
function downloadAndOpen(win, asset) {
  const t = tr()
  const dest = path.join(app.getPath('downloads'), asset.name)
  return new Promise((resolve) => {
    const req = net.request({ url: asset.browser_download_url, redirect: 'follow' })
    req.setHeader('User-Agent', 'PRCockpit-Updater')
    req.on('response', (res) => {
      if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
        res.on('data', () => {})
        res.on('end', () => {
          if (win && !win.isDestroyed()) win.setProgressBar(-1)
          dialog.showErrorBox(t.failed_title, `HTTP ${res.statusCode}`)
          resolve(false)
        })
        return
      }
      const total = Number(res.headers['content-length'] || 0)
      let received = 0
      let settled = false
      const file = fs.createWriteStream(dest)
      const clearProgress = () => {
        if (win && !win.isDestroyed()) win.setProgressBar(-1)
      }
      // 任何失败路径统一走这里:只结算一次、清进度条、销毁流、删掉残缺文件、报错。
      const fail = (err) => {
        if (settled) return
        settled = true
        clearProgress()
        try {
          file.destroy()
        } catch {
          /* ignore */
        }
        fs.unlink(dest, () => {}) // 别在 Downloads 里留半截文件
        dialog.showErrorBox(t.failed_title, err?.message || String(err))
        resolve(false)
      }
      res.on('data', (chunk) => {
        received += chunk.length
        if (total && win && !win.isDestroyed()) win.setProgressBar(Math.min(received / total, 1))
      })
      // 关键:源(res)中途出错/中断不会被 res.pipe(file) 转发给 file,
      // 那样 file 既不 finish 也不 error → Promise 永挂、spinner/进度条卡死。自己接住。
      res.on('error', fail)
      res.on('aborted', () => fail(new Error('Download aborted')))
      res.pipe(file)
      file.on('finish', () => {
        if (settled) return
        settled = true
        file.close(() => {
          clearProgress()
          shell.openPath(dest) // 打开 DMG/安装包(mac 下会挂载)
          dialog
            .showMessageBox(win && !win.isDestroyed() ? win : undefined, {
              type: 'info',
              title: t.downloaded_title,
              message: t.downloaded_title,
              detail: t.downloaded_detail(asset.name),
              buttons: [t.reveal, t.ok],
              defaultId: 1,
              cancelId: 1,
            })
            .then(({ response }) => {
              if (response === 0) shell.showItemInFolder(dest)
              resolve(true)
            })
        })
      })
      file.on('error', fail)
    })
    req.on('error', (err) => {
      if (win && !win.isDestroyed()) win.setProgressBar(-1)
      dialog.showErrorBox(t.failed_title, err.message)
      resolve(false)
    })
    req.end()
  })
}

// 检查更新。silent=true(启动时自动):无更新/失败都不打扰;有更新才弹窗。
// silent=false(手动「检查更新」):无更新/失败也给回执。
export async function checkForUpdates(win, { silent = true, locale } = {}) {
  if (locale) setUpdaterLocale(locale)
  const t = tr()
  if (!app.isPackaged) {
    if (!silent) dialog.showMessageBox(win || undefined, { type: 'info', message: t.uptodate_title, detail: t.dev_detail })
    return
  }
  const build = readBuildInfo()
  if (!build || !build.time) {
    if (!silent) dialog.showMessageBox(win || undefined, { type: 'info', message: t.failed_title, detail: 'build-info.json missing' })
    return
  }

  let release
  try {
    release = await fetchJson(`https://api.github.com/repos/${UPDATE_REPO}/releases/tags/${RELEASE_TAG}`)
  } catch (err) {
    if (!silent) dialog.showMessageBox(win || undefined, { type: 'warning', message: t.failed_title, detail: String(err.message || err) })
    return
  }

  const { asset, update, remoteSha } = computeUpdate(build, release)
  if (!update || !asset) {
    if (!silent) dialog.showMessageBox(win || undefined, { type: 'info', message: t.uptodate_title, detail: t.uptodate_detail })
    return
  }

  const remoteLabel = `${remoteSha || asset.name} · ${asset.updated_at?.slice(0, 10) || ''}`
  const ourLabel = `${(build.sha || '').slice(0, 7) || build.version || '?'} · ${build.time.slice(0, 10)}`
  const { response } = await dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, {
    type: 'info',
    title: t.available_title,
    message: t.available_title,
    detail: t.available_detail(remoteLabel, ourLabel),
    buttons: [t.download, t.later, t.viewPage],
    defaultId: 0,
    cancelId: 1,
  })
  if (response === 0) await downloadAndOpen(win, asset)
  else if (response === 2) shell.openExternal(release.html_url || `https://github.com/${UPDATE_REPO}/releases/tag/${RELEASE_TAG}`)
}

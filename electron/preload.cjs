// Minimal secure bridge between the renderer and the main process (under contextIsolation + sandbox).
// Exposes only one capability — "trigger an update check" — not arbitrary ipc. Uses .cjs to force CommonJS
// (package.json is type:module, and preload must be CJS under sandbox).
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('mrUpdates', {
  // Trigger one manual (non-silent) check: the main process shows the result in a native dialog. Passes the language selected in the app.
  check: (locale) => ipcRenderer.invoke('updates:check', locale),
  // Tell the main process the current app language so the startup silent-check dialog uses the right one too.
  setLocale: (locale) => ipcRenderer.send('updates:locale', locale),
})

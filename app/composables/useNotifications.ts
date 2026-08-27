// Browser notifications for "the agent is waiting on you": opt-in per browser (Notification.requestPermission needs a
// user gesture), remembered in localStorage. The caller decides when something new is worth a notification.
const KEY = 'mr.notify'

export function useNotifications() {
  const supported = typeof window !== 'undefined' && 'Notification' in window
  const enabled = useState<boolean>('notify.enabled', () => {
    try { return supported && localStorage.getItem(KEY) === '1' && Notification.permission === 'granted' } catch { return false }
  })

  async function toggle(): Promise<void> {
    if (!supported) return
    if (enabled.value) { enabled.value = false; try { localStorage.setItem(KEY, '0') } catch { /* ignore */ } return }
    let perm = Notification.permission
    if (perm !== 'granted') perm = await Notification.requestPermission()
    enabled.value = perm === 'granted'
    try { localStorage.setItem(KEY, enabled.value ? '1' : '0') } catch { /* ignore */ }
  }

  function notify(title: string, body?: string, onClick?: () => void): void {
    if (!enabled.value || !supported || Notification.permission !== 'granted') return
    try {
      const n = new Notification(title, { body, tag: 'pr-cockpit-inbox', silent: false })
      if (onClick) n.onclick = () => { window.focus(); onClick(); n.close() }
    } catch { /* a blocked constructor (some embedded contexts) must not break the page */ }
  }

  return { supported, enabled, toggle, notify }
}

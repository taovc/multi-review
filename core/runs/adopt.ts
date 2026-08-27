// Directory sessions created before the assistant was scoped to projects carry no projectId. They are "adopted" by the
// project whose local clone contains their working directory — exact match or a path *inside* it (a separator is
// required, so `~/work/app` never adopts `~/work/app-mobile`). Shared by the runs list and the inbox.
export function projectForPath(projects: Array<{ id: string; localPath: string | null }>, path: string | null | undefined): string | null {
  if (!path) return null
  for (const p of projects) {
    const base = (p.localPath || '').trim().replace(/\/+$/, '')
    if (base && (path === base || path.startsWith(`${base}/`))) return p.id
  }
  return null
}

import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fetchIssueBody, ghToken } from './gh'

// Feature requests are often pasted in as GitHub issue/PR links. A read-only agent can't reach the network or
// download images (the guard blocks curl/WebFetch), so the backend fetches body + images up front: the body is
// folded into the requirement text, and images are downloaded with the gh token so the Read tool can view them.
// Only GitHub image hosts are accepted (same allowlist as server/api/img, to prevent SSRF / downloading arbitrary external URLs).
const IMG_ALLOW = /^https:\/\/(github\.com\/user-attachments\/|[a-z0-9-]+\.githubusercontent\.com\/)/i

export type GithubRef = { repo: string; kind: 'issue' | 'pr'; number: number }

// Pull GitHub issue / PR links out of arbitrary text (deduplicated).
export function extractGithubRefs(text: string): GithubRef[] {
  const re = /https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(issues|pull)\/(\d+)/gi
  const seen = new Set<string>()
  const out: GithubRef[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const repo = m[1]!
    const kind = m[2]!.toLowerCase() === 'pull' ? 'pr' : 'issue'
    const number = Number(m[3])
    const key = `${repo}#${kind}#${number}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ repo, kind, number })
  }
  return out
}

// Pull image URLs out of a markdown / HTML body (<img src> and ![](url)), deduplicated and restricted to GitHub image hosts.
export function extractImageUrls(body: string): string[] {
  const urls: string[] = []
  const html = /<img[^>]*\bsrc=["']([^"']+)["']/gi
  const md = /!\[[^\]]*\]\(([^)\s]+)/g
  let m: RegExpExecArray | null
  while ((m = html.exec(body))) urls.push(m[1]!)
  while ((m = md.exec(body))) urls.push(m[1]!)
  return [...new Set(urls)].filter((u) => IMG_ALLOW.test(u))
}

// Download one image with the gh token (attachments on private repos 404 without it; same approach as server/api/img).
// The filename is an index plus an extension inferred from content-type (attachment URLs are extensionless uuids).
// Returns the absolute path on disk, or null.
async function downloadImage(url: string, destDir: string, idx: number, token: string): Promise<string | null> {
  const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {}, redirect: 'follow' }).catch(() => null)
  if (!res || !res.ok) return null
  const ct = res.headers.get('content-type') || ''
  if (!ct.startsWith('image/')) return null
  const ext = ct.includes('png') ? 'png'
    : ct.includes('gif') ? 'gif'
      : ct.includes('webp') ? 'webp'
        : (ct.includes('jpeg') || ct.includes('jpg')) ? 'jpg'
          : 'png'
  const path = join(destDir, `img-${idx + 1}.${ext}`)
  await writeFile(path, Buffer.from(await res.arrayBuffer()))
  return path
}

export type IssueContext = { enrichedText: string; imagePaths: string[]; summary: string }

// Fetch the GitHub issues/PRs referenced in sourceText: bodies are joined into supplementary text, images land in destDir.
// Best effort: no single step is fatal, whatever was collected is returned; returns null when there is not a single ref.
export async function fetchIssueContext(sourceText: string, destDir: string): Promise<IssueContext | null> {
  const refs = extractGithubRefs(sourceText)
  if (!refs.length) return null
  const token = await ghToken().catch(() => '')
  await mkdir(destDir, { recursive: true }).catch(() => {})

  const blocks: string[] = []
  const imagePaths: string[] = []
  for (const ref of refs) {
    let title = ''
    let body = ''
    try {
      ({ title, body } = await fetchIssueBody(ref.repo, ref.kind, ref.number))
    } catch {
      continue // Body not available (no permission / doesn't exist) → skip this ref
    }
    const label = `${ref.repo}#${ref.number}`
    const imgUrls = extractImageUrls(body)
    let downloaded = 0
    for (const u of imgUrls) {
      const p = await downloadImage(u, destDir, imagePaths.length, token).catch(() => null)
      if (p) { imagePaths.push(p); downloaded++ }
    }
    const imgNote = downloaded ? `\n\n(This ${ref.kind === 'pr' ? 'PR' : 'issue'} comes with ${downloaded} image(s), already downloaded locally; their paths are in the "Images" list below — you MUST open and look at every one of them.)` : ''
    blocks.push(`### Fetched ${ref.kind === 'pr' ? 'PR' : 'Issue'} ${label}: ${title}\n\n${body}${imgNote}`)
  }
  if (!blocks.length) return null
  return {
    enrichedText: blocks.join('\n\n---\n\n'),
    imagePaths,
    summary: `${blocks.length} 个链接，${imagePaths.length} 张图`,
  }
}

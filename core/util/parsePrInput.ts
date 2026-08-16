// Parse a blob of text pasted by the user into a list of PRs.
// Supports: full URLs, bare numbers, owner/repo#N, #N, mixed with commas/spaces/newlines.
export type ParsedPr = { repo: string | null; number: number }

const URL_RE = /github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/i
const OWNER_REPO_HASH_RE = /^([^/\s]+\/[^/\s]+)#(\d+)$/
const HASH_NUM_RE = /^#?(\d+)$/

export function parsePrInput(text: string, defaultRepo: string | null = null): ParsedPr[] {
  const tokens = text
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean)

  const out: ParsedPr[] = []
  const seen = new Set<string>()

  for (const tok of tokens) {
    let repo: string | null = defaultRepo
    let num: number | null = null

    const url = tok.match(URL_RE)
    if (url) {
      repo = url[1]!
      num = Number(url[2])
    } else {
      const orh = tok.match(OWNER_REPO_HASH_RE)
      if (orh) {
        repo = orh[1]!
        num = Number(orh[2])
      } else {
        const hn = tok.match(HASH_NUM_RE)
        if (hn) num = Number(hn[1])
      }
    }

    if (num == null || Number.isNaN(num)) continue
    const key = `${repo ?? ''}#${num}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ repo, number: num })
  }

  return out
}

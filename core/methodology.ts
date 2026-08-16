import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

const DEFAULT_METHODOLOGY = `You are a senior code reviewer. Review this PR strictly but pragmatically:
- Start with the cross-cutting impact: grep the whole repo for call sites of the changed exports/shared components, and list the affected scope
- Data flow, permission boundaries, input validation, concurrency/races, error handling, test gaps
- Severity: High = must be fixed or it cannot be merged / Medium = strongly recommended / Low = cleanup
- Write "does not hold" for points that don't hold up; state "not introduced by this PR" for pre-existing issues; don't inflate low-priority items into blockers
- Every finding must give path:line`

function expandHome(p: string) {
  return p.startsWith('~') ? resolve(homedir(), p.slice(1).replace(/^[/\\]/, '')) : p
}

// A project's review methodology: inline md first, then the file path, then the default
export function loadMethodology(opts: {
  methodologyMd?: string | null
  methodologyRef?: string | null
}): string {
  if (opts.methodologyMd && opts.methodologyMd.trim()) return opts.methodologyMd
  if (opts.methodologyRef && opts.methodologyRef.trim()) {
    try {
      return readFileSync(expandHome(opts.methodologyRef), 'utf8')
    } catch {
      // fall back to the default when it can't be read
    }
  }
  return DEFAULT_METHODOLOGY
}

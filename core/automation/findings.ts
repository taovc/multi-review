import { eq, asc, inArray } from 'drizzle-orm'

// Single definition of an "outstanding finding": severity is High/Medium (we don't chase Low/nit) and it is not yet resolved.
// Decided in reverse, via a "resolved" allowlist: only fixed/retracted/replied count as resolved, everything else counts as
// unresolved = still to fix — so kept (AI stands by the finding, still valid), adjusted (severity changed, still valid), discuss,
// new, unaddressed and partial are all correctly treated as still to fix, never mistaken for resolved, so a High is never dropped
// and convergence is never falsely reported (allowlisting the unresolved statuses instead would miss any newly added status).
// Auto-fix's "should we fix again / have we converged" (engine uses actionable) and "the instructions fed to the agent"
// (buildAutoFixMessage uses actionableFindings) both rely on this definition, so it lives here in reviewFindingStats to keep the
// two from drifting apart. db/schema are injected by the caller (core does not depend on the runtime db directly).
const ACTIONABLE_SEVERITY = new Set(['High', 'Medium'])
const RESOLVED_RECHECK = new Set(['fixed', 'retracted', 'replied'])

export type ReviewFindingStats = {
  total: number // total findings from the review (0 = clean PR)
  actionable: number // how many still need handling
  actionableFindings: any[] // the finding rows still needing handling (by sortOrder, for buildAutoFixMessage)
}

// One scan yields total + outstanding count + outstanding rows (the engine gets everything at once, no repeated db reads).
export function reviewFindingStats(db: any, schema: any, reviewId: string): ReviewFindingStats {
  const findings = db
    .select()
    .from(schema.findings)
    .where(eq(schema.findings.reviewId, reviewId))
    .orderBy(asc(schema.findings.sortOrder))
    .all() as any[]
  if (!findings.length) return { total: 0, actionable: 0, actionableFindings: [] }

  const ids = findings.map((f) => f.id)
  const rechecks = db.select().from(schema.findingRechecks).where(inArray(schema.findingRechecks.findingId, ids)).all() as any[]
  // For each finding, take the recheck status from the latest round (highest round)
  const latest = new Map<string, { round: number; status: string }>()
  for (const rc of rechecks) {
    const cur = latest.get(rc.findingId)
    if (!cur || rc.round > cur.round) latest.set(rc.findingId, { round: rc.round, status: rc.status })
  }

  const actionableFindings = findings.filter((f) => {
    if (!ACTIONABLE_SEVERITY.has(f.severity)) return false
    if (f.verifyStatus === 'refuted') return false // the verify pass refuted it → not something to auto-fix
    const rc = latest.get(f.id)
    return !rc || !RESOLVED_RECHECK.has(rc.status) // never rechecked, or the latest recheck is not "resolved" → still to fix
  })
  return { total: findings.length, actionable: actionableFindings.length, actionableFindings }
}

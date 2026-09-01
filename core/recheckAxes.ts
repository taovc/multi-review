// A re-review round records two independent verdicts per finding, and everything downstream has to read the right one.
//
//   author move — what the AUTHOR did about it: fixed / partial / unaddressed / replied / new
//   stance      — what WE now think of the finding: kept / retracted / adjusted / discuss
//
// They used to share one column, which is why a single word had to answer both questions and why "the author fixed it,
// and I no longer think it was worth raising" could not be said at all. The column stayed put for the author move
// (every existing reader and every historical row uses it); the stance moved to its own nullable column.
//
// Rows written before the split hold a stance word in `status` and no `stance`, so both accessors fall back to reading
// `status` and deciding by vocabulary. Anything that acts on a recheck row goes through here — posting, the automation
// engine, the metrics and the drawer all made the same mistake once, and it is not a mistake that shows up in tests
// that only exercise the writer.

export const STANCE_WORDS = new Set(['kept', 'retracted', 'adjusted', 'discuss'])
export const AUTHOR_MOVES = new Set(['fixed', 'partial', 'unaddressed', 'replied', 'new'])

export type RecheckAxes = { status: string; stance?: string | null }

// What we think of the finding now. Null when the row records only an author move (which is the normal case for a
// round where our position did not come up).
export function stanceOf(r: RecheckAxes | null | undefined): string | null {
  if (!r) return null
  if (r.stance && STANCE_WORDS.has(r.stance)) return r.stance
  return STANCE_WORDS.has(r.status) ? r.status : null
}

// What the author did. Null on an old row that recorded only our stance.
export function authorMoveOf(r: RecheckAxes | null | undefined): string | null {
  if (!r) return null
  return AUTHOR_MOVES.has(r.status) ? r.status : null
}

// Is this finding done with, as far as further work goes? Either we withdrew it, or the author dealt with it.
// Used by the automation engine to decide what is still worth handing to the fix agent: a finding we retracted must
// drop out, or auto-fix keeps re-fixing something the review already took back.
export function isRecheckResolved(r: RecheckAxes | null | undefined): boolean {
  if (!r) return false
  if (stanceOf(r) === 'retracted') return true
  const move = authorMoveOf(r)
  return move === 'fixed' || move === 'replied'
}

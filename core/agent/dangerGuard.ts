
// Pure in-process version of the same rules, used by the session host's PreToolUse callback (core/host/permissions.ts).
// Keep the two lists identical: this one is the source of truth for the host, DANGER_HOOK_SRC below is the file hook used by the `claude -p` spawn path.
export const DANGER_PATTERNS: RegExp[] = [
  /\brm\s+-[rf]/i, /\brm\b[^|;&]*--(recursive|force)\b/i, /\bfind\b[^|;&]*-(delete|exec)\b/i,
  /\bsudo\b/i,
  /\bgit\b[^|;&]*\bpush\b/i, /\bgit\b[^|;&]*\breset\b[^|;&]*--hard\b/i,
  /\bgit\b[^|;&]*\bclean\b[^|;&]*-[a-z]*f/i, /\b(mkfs|shred)\b/i, /\bdd\s+if=/i, /\bchmod\s+-R\b/i, /\bchown\s+-R\b/i,
  /\b(curl|wget)\b[^|]*\|\s*(sh|bash|zsh|python3?|node|perl|ruby)\b/i,
  /:\(\)\s*\{/, />\s*\/dev\/sd/i, /\bgh\b[^|;&]*\brepo\b[^|;&]*\bdelete\b/i,
  /\bgh\b[^|;&]*\b(pr|issue|release)\b[^|;&]*\bcreate\b/i,
]
export function isDangerousCommand(cmd: string): boolean {
  return DANGER_PATTERNS.some((re) => re.test(cmd || ''))
}

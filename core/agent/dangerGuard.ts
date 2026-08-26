import { writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

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

// ── Dangerous-command guard (PreToolUse hook) ──
// The CLI path (bypassPermissions) has no SDK canUseTool, so the hook is the only reliable interception point
// (verified: hooks still fire under bypassPermissions). By default it blocks "irreversible / outward-facing" destructive Bash commands;
// GLOBAL_ALLOW_DANGER=1 (the user turned on the "allow dangerous commands" switch) lets everything through.
// Only the genuinely dangerous ones are gated — git commit / plain curl / gh reads all run normally.
// The global assistant and the feature development assistant share this one file.
const DANGER_HOOK_SRC = `import { readFileSync } from 'node:fs'
if (process.env.GLOBAL_ALLOW_DANGER === '1') process.exit(0)
let raw = ''; try { raw = readFileSync(0, 'utf8') } catch {}
let inp = {}; try { inp = JSON.parse(raw) } catch {}
if ((inp.tool_name || '') !== 'Bash') process.exit(0)
const cmd = String((inp.tool_input || {}).command || '')
const DANGER = [
  /\\brm\\s+-[rf]/i, /\\brm\\b[^|;&]*--(recursive|force)\\b/i, /\\bfind\\b[^|;&]*-(delete|exec)\\b/i,
  /\\bsudo\\b/i,
  // git/gh: the verb is allowed to sit after leading flags (stops \`git -C dir push\` / \`gh --repo o/r pr create\` from bypassing the guard). [^|;&] keeps the match inside a single command.
  /\\bgit\\b[^|;&]*\\bpush\\b/i, /\\bgit\\b[^|;&]*\\breset\\b[^|;&]*--hard\\b/i,
  /\\bgit\\b[^|;&]*\\bclean\\b[^|;&]*-[a-z]*f/i, /\\b(mkfs|shred)\\b/i, /\\bdd\\s+if=/i, /\\bchmod\\s+-R\\b/i, /\\bchown\\s+-R\\b/i,
  /\\b(curl|wget)\\b[^|]*\\|\\s*(sh|bash|zsh|python3?|node|perl|ruby)\\b/i,
  /:\\(\\)\\s*\\{/, />\\s*\\/dev\\/sd/i, /\\bgh\\b[^|;&]*\\brepo\\b[^|;&]*\\bdelete\\b/i,
  /\\bgh\\b[^|;&]*\\b(pr|issue|release)\\b[^|;&]*\\bcreate\\b/i,
]
if (DANGER.some((re) => re.test(cmd))) {
  process.stderr.write('pr-cockpit danger guard blocked: ' + cmd.slice(0, 160) + ' — turn on "allow dangerous commands" and resend to permit.')
  process.exit(2)
}
process.exit(0)
`

let _hookPath: string | null = null
function ensureDangerHook(): string {
  if (_hookPath && existsSync(_hookPath)) return _hookPath
  const dir = join(process.cwd(), 'data')
  try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) } catch { /* ignore */ }
  const p = join(dir, 'global-danger-hook.mjs')
  try { writeFileSync(p, DANGER_HOOK_SRC, 'utf8') } catch { /* ignore */ }
  _hookPath = p
  return p
}

// Inject the dangerous-command PreToolUse hook into the claude CLI's --settings. Returns a string usable directly as `--settings <json>`.
export function dangerSettingsJson(): string {
  const hook = ensureDangerHook()
  return JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `node ${hook}` }] }] },
  })
}

// allowDanger=true → inject the bypass environment variable (when the guard script sees it, every command is let through).
export function dangerEnv(allowDanger?: boolean): Record<string, string> | undefined {
  return allowDanger ? { GLOBAL_ALLOW_DANGER: '1' } : undefined
}

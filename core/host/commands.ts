// The slash-command catalogue behind the session composer's "/" palette. Entries come from the CLI (probe or a live
// session's commands_changed push) and are classified: the user's own skills, plugin commands, and the built-ins —
// of which only a curated set is shown by default (the rest sits behind "show all"; terminal/session-killing ones
// are always hidden). Matching is PREFIX matching on the name, on any namespace segment and on aliases, so `/plan`
// finds `speckit.plan` and `Notion:tasks:plan` without fuzzy noise.

export type CommandOrigin = 'user' | 'plugin' | 'builtin' | 'codex-skill' | 'local'

export type CommandEntry = {
  name: string // what the CLI executes (`/name …`); Codex skills use the skill name
  description: string
  argumentHint: string
  aliases: string[]
  origin: CommandOrigin
  plugin?: string // for plugin commands: the namespace before the first ':' (Notion, ralph-loop, …)
  shortName: string // display name inside a plugin group
  curated: boolean // shown without "show all"
  path?: string // Codex skills: the path the app-server wants in the skill input item
}

// Built-ins that make sense in a persistent GUI session (everything else the CLI advertises is hidden by default).
export const CURATED_BUILTINS = new Set(['compact', 'context', 'cost', 'usage', 'model', 'effort', 'review', 'security-review', 'init', 'mcp', 'insights', 'recap', 'memory'])
// Never shown: they kill or re-auth the process, or only mean something in a terminal.
export const HIDDEN_COMMANDS = new Set(['exit', 'quit', 'login', 'logout', 'doctor', 'color', 'vim', 'theme', 'statusline', 'terminal-setup', 'heapdump'])

export type RawCommand = { name: string; description?: string; argumentHint?: string; aliases?: string[] }

function isPluginName(name: string): boolean {
  return name.includes(':') || name.startsWith('mcp__plugin_')
}

// The CLI suffixes user/project skills with " (user)" / " (project)" in their description; built-ins carry no suffix.
function isUserSkill(description: string): boolean {
  return /\((user|project)\)\s*$/.test(description)
}

export function classifyCommand(c: RawCommand, opts: { terminalOnly?: Set<string> } = {}): CommandEntry | null {
  // MCP prompts exposed by plugins are listed as "plugin:<plugin>:<server>:<prompt> (MCP)"; the suffix is display-only.
  const name = String(c.name ?? '').trim().replace(/\s+\(MCP\)\s*$/, '')
  if (!name) return null
  if (HIDDEN_COMMANDS.has(name) || opts.terminalOnly?.has(name)) return null
  const description = String(c.description ?? '').replace(/\s*\((user|project|plugin)\)\s*$/, '').trim()
  const colon = name.startsWith('plugin:') ? name.split(':').slice(1) : name.split(':') // ['Notion', 'tasks', 'plan']
  const plugin = isPluginName(name) ? (name.startsWith('mcp__plugin_') ? name.split('__')[1]?.replace(/^plugin_/, '').split('_')[0] ?? 'plugin' : colon[0]!) : undefined
  const origin: CommandOrigin = plugin ? 'plugin' : isUserSkill(String(c.description ?? '')) ? 'user' : 'builtin'
  const shortName = plugin ? (name.startsWith('mcp__plugin_') ? name.split('__').slice(2).join('__') : colon.slice(1).join(':')) : name
  return {
    name, description, argumentHint: String(c.argumentHint ?? ''), aliases: Array.isArray(c.aliases) ? c.aliases.map(String) : [],
    origin, plugin, shortName: shortName || name, curated: origin !== 'builtin' || CURATED_BUILTINS.has(name),
  }
}

export function classifyCommands(list: RawCommand[], opts: { terminalOnly?: Set<string> } = {}): CommandEntry[] {
  const out: CommandEntry[] = []
  const seen = new Set<string>()
  for (const c of list) {
    const e = classifyCommand(c, opts)
    if (e && !seen.has(e.name)) { seen.add(e.name); out.push(e) }
  }
  return out
}

export function codexSkillEntries(skills: Array<{ name: string; description?: string; path?: string; enabled?: boolean }>): CommandEntry[] {
  return skills.filter((s) => s.enabled !== false && s.name).map((s) => {
    const plugin = s.name.includes(':') ? s.name.split(':')[0] : undefined
    return { name: s.name, description: String(s.description ?? ''), argumentHint: '', aliases: [], origin: 'codex-skill' as const, plugin, shortName: plugin ? s.name.split(':').slice(1).join(':') : s.name, curated: true, path: s.path }
  })
}

// Prefix match: `head` is what the user typed after "/" (lower-cased, no slash). Matches the name, any segment of a
// namespaced name (`speckit.plan` → plan; `Notion:tasks:plan` → tasks, plan) and any alias.
export function matchesPrefix(e: Pick<CommandEntry, 'name' | 'aliases'>, head: string): boolean {
  const h = head.toLowerCase()
  if (!h) return true
  const name = e.name.toLowerCase()
  if (name.startsWith(h)) return true
  if (name.split(/[.:]|__/).some((seg) => seg && seg.startsWith(h))) return true
  return e.aliases.some((a) => a.toLowerCase().startsWith(h))
}

export function filterCommands(entries: CommandEntry[], head: string, showAll: boolean): CommandEntry[] {
  return entries.filter((e) => (showAll || e.curated) && matchesPrefix(e, head))
}

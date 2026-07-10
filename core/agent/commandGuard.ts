function shellWords(input: string): string[] | null {
  const words: string[] = []
  let cur = ''
  let i = 0
  let inWord = false
  const push = () => {
    if (inWord) words.push(cur)
    cur = ''
    inWord = false
  }
  while (i < input.length) {
    const ch = input[i]!
    if (/\s/.test(ch)) {
      push()
      i++
      continue
    }
    inWord = true
    if (ch === "'") {
      i++
      while (i < input.length && input[i] !== "'") cur += input[i++]
      if (input[i] !== "'") return null
      i++
      continue
    }
    if (ch === '"') {
      i++
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < input.length) i++
        cur += input[i++]
      }
      if (input[i] !== '"') return null
      i++
      continue
    }
    if (ch === '$' && input[i + 1] === "'") {
      i += 2
      while (i < input.length && input[i] !== "'") {
        if (input[i] === '\\' && i + 1 < input.length) i++
        cur += input[i++]
      }
      if (input[i] !== "'") return null
      i++
      continue
    }
    if (ch === '\\' && i + 1 < input.length) i++
    cur += input[i++]
  }
  push()
  return words
}

function splitShellAndSegments(input: string): string[] | null {
  const out: string[] = []
  let cur = ''
  let quote: "'" | '"' | '$\'' | null = null
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!
    const next = input[i + 1]
    if (quote === "'") {
      if (ch === "'") quote = null
      cur += ch
      continue
    }
    if (quote === '"') {
      if (ch === '\\' && next) { cur += ch + next; i++; continue }
      if (ch === '`' || ch === '$') return null
      if (ch === '"') quote = null
      cur += ch
      continue
    }
    if (quote === '$\'') {
      if (ch === '\\' && next) { cur += ch + next; i++; continue }
      if (ch === "'") quote = null
      cur += ch
      continue
    }
    if (ch === "'") { quote = "'"; cur += ch; continue }
    if (ch === '"') { quote = '"'; cur += ch; continue }
    if (ch === '$' && next === "'") { quote = "$'"; cur += ch + next; i++; continue }
    if (ch === '$' || ch === '`' || ch === ';' || ch === '|' || ch === '<' || ch === '>' || ch === '\n') return null
    if (ch === '&') {
      if (next !== '&') return null
      out.push(cur.trim())
      cur = ''
      i++
      continue
    }
    cur += ch
  }
  if (quote) return null
  out.push(cur.trim())
  return out.filter(Boolean)
}

function unwrapShellLc(command: string): string | null {
  const words = shellWords(command)
  if (!words || words.length !== 3) return null
  const shell = words[0]!.split('/').pop()
  return shell && ['sh', 'bash', 'zsh'].includes(shell) && words[1] === '-lc' ? words[2]! : null
}

function commandSegments(command: string): string[] | null {
  const trimmed = command.trim()
  if (!trimmed) return null
  return splitShellAndSegments(unwrapShellLc(trimmed) ?? trimmed)
}

function gitCommandPattern(commandPattern: string): RegExp {
  const gitOption = String.raw`(?:-[A-Za-z](?:\s+\S+)?|--[A-Za-z0-9-]+(?:[=\s]\S+)?)`
  return new RegExp(String.raw`\bgit\b(?:\s+${gitOption})*\s+${commandPattern}(?=\s|$|[|;&])`, 'i')
}

function ghCommandPattern(commandPattern: string): RegExp {
  const ghOption = String.raw`(?:-[A-Za-z](?:\s+\S+)?|--[A-Za-z0-9-]+(?:[=\s]\S+)?)`
  return new RegExp(String.raw`\bgh\b(?:\s+${ghOption})*\s+${commandPattern}(?=\s|$|[|;&])`, 'i')
}

const GIT_REMOTE_MUTATION_RE = gitCommandPattern('push')
const GIT_LOCAL_MUTATION_RES = [
  gitCommandPattern('(?:add|commit|reset|checkout|switch|merge|rebase|restore|clean|cherry-pick|revert|apply|am|mv|rm)'),
  gitCommandPattern(String.raw`branch\s+(?:-[dDmMcC]\b|--(?:delete|move|copy|set-upstream-to|unset-upstream)\b|[^\s-]\S*)`),
  gitCommandPattern(String.raw`tag\s+(?:-[adfsm]\b|--(?:annotate|delete|sign|force|message)\b|[^\s-]\S*)`),
  gitCommandPattern(String.raw`stash\s+(?:push|pop|apply|drop|clear|save|store|branch|create)\b`),
  gitCommandPattern(String.raw`worktree\s+(?:add|remove|move|prune|repair)\b`),
  gitCommandPattern(String.raw`remote\s+(?:add|remove|rm|rename|set-url|prune)\b`),
  gitCommandPattern(String.raw`config\s+(?:(?:--global|--system|--local)\s+)?(?:--add|--unset|--unset-all|--replace-all|--rename-section|--remove-section|--edit)\b`),
]
const GH_MUTATION_RE = ghCommandPattern(String.raw`pr\s+(?:create|review|comment|merge|close|edit|ready|reopen)`)
const GH_API_MUTATION_RE = ghCommandPattern(String.raw`api\b.*(?:--method|-X)\s*(?:POST|PUT|PATCH|DELETE)\b`)

export function isForbiddenRemoteOrGitMutation(command: string, opts: { allowLocalGitMutation?: boolean } = {}): boolean {
  return GIT_REMOTE_MUTATION_RE.test(command)
    || GH_MUTATION_RE.test(command)
    || GH_API_MUTATION_RE.test(command)
    || (!opts.allowLocalGitMutation && GIT_LOCAL_MUTATION_RES.some((re) => re.test(command)))
}

function isAllowedFeaturePublishSegment(segment: string): boolean {
  const words = shellWords(segment)
  if (!words?.length) return false
  const [cmd, sub, action] = words
  if (cmd === 'git' && sub === 'add') return words.length >= 2
  if (cmd === 'git' && sub === 'commit') return words.length >= 2
  if (cmd === 'git' && sub === 'push') {
    return words.length === 5 && ['-u', '--set-upstream'].includes(words[2]!) && words[3] === 'origin' && words[4] === 'HEAD'
  }
  return cmd === 'gh' && sub === 'pr' && action === 'create'
}

export function isAllowedFeaturePublishCommand(command: string): boolean {
  const segments = commandSegments(command)
  return !!segments?.length && segments.every(isAllowedFeaturePublishSegment)
}

export type CodexCommandGuardScope = 'readonly' | 'fix' | 'feature' | 'global'

export function shouldBlockCodexCommand(
  command: string,
  opts: { scope: CodexCommandGuardScope; allowDanger?: boolean; networkAccess?: boolean },
): boolean {
  if (opts.scope === 'global') return false
  if (opts.scope === 'feature' && opts.allowDanger && opts.networkAccess && isAllowedFeaturePublishCommand(command)) return false
  const allowLocalGitMutation = opts.scope === 'fix' && !!opts.allowDanger
  return isForbiddenRemoteOrGitMutation(command, { allowLocalGitMutation })
}

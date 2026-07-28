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

export type CodexCommandGuardScope = 'readonly' | 'fix' | 'feature' | 'global'

export function shouldBlockCodexCommand(
  command: string,
  opts: { scope: CodexCommandGuardScope; allowDanger?: boolean },
): boolean {
  if (opts.scope === 'global' || opts.allowDanger) return false
  return isForbiddenRemoteOrGitMutation(command)
}

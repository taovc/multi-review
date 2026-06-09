import { runClaudeStream } from './claudeCli'

export type FixSteps = { fix: boolean; simplify: boolean; tests: boolean; testsUI: boolean }

// 修复 agent：在 worktree（cwd）里按反馈改代码 + 内联 simplify（可选）+ UI 校验（可选，走 MCP）。
// 安全：禁 git / 网络 / 破坏性命令（见 disallowed），Node 负责 commit/push。
// allowed 里给了 Edit/Write + 受限 bash；--permission-mode acceptEdits 自动批准编辑。
const ALLOWED = [
  'Read', 'Grep', 'Glob', 'Edit', 'Write',
  'Bash(pnpm:*)', 'Bash(ls:*)', 'Bash(cat:*)', 'Bash(rg:*)', 'Bash(grep:*)', 'Bash(sed:*)', 'Bash(node:*)', 'Bash(npx:*)',
]
const DISALLOWED = [
  'Bash(git:*)', 'Bash(curl:*)', 'Bash(wget:*)', 'Bash(nc:*)', 'Bash(ncat:*)', 'Bash(ssh:*)', 'Bash(scp:*)',
  'Bash(rsync:*)', 'Bash(rm:*)', 'Bash(sudo:*)', 'Bash(chmod:*)', 'Bash(chown:*)', 'Bash(kill:*)', 'Bash(pkill:*)',
]

export async function runFixAgent(opts: {
  cwd: string
  brief: string
  steps: FixSteps
  model: string
  devUrl?: string
  mcpConfigPath?: string
  onTool?: (name: string, info: string) => void
  onText?: (text: string) => void
}): Promise<{ costUsd: number }> {
  const args = [
    '-p',
    '--verbose',
    '--output-format', 'stream-json',
    '--model', opts.model,
    '--permission-mode', 'acceptEdits',
    '--allowedTools', ALLOWED.join(','),
    '--disallowedTools', DISALLOWED.join(','),
  ]
  if (opts.steps.testsUI && opts.mcpConfigPath) {
    args.push('--mcp-config', opts.mcpConfigPath, '--strict-mcp-config')
  }

  const { costUsd } = await runClaudeStream(args, {
    input: buildFixPrompt(opts),
    cwd: opts.cwd,
    onEvent: (msg) => {
      if (msg?.type !== 'assistant') return
      const content = msg.message?.content
      if (!Array.isArray(content)) return
      for (const b of content) {
        if (b?.type === 'text' && b.text) opts.onText?.(String(b.text))
        else if (b?.type === 'tool_use') opts.onTool?.(String(b.name), toolInfo(b))
      }
    },
  })
  return { costUsd }
}

function buildFixPrompt(opts: { brief: string; steps: FixSteps; devUrl?: string }): string {
  const { steps, brief, devUrl } = opts
  const tasks: string[] = []
  if (steps.fix) tasks.push('1. Corrige le code pour traiter chaque commentaire de revue ci-dessous. Garde les changements minimaux et ciblés.')
  if (steps.simplify) tasks.push(`${tasks.length + 1}. Simplifie ensuite le code que tu as modifié : réduis la duplication, factorise, supprime le code mort — SANS changer le comportement.`)
  if (steps.testsUI && devUrl) {
    tasks.push(
      `${tasks.length + 1}. Valide l'UI avec les outils MCP chrome-devtools sur le dev server déjà lancé (${devUrl}) : navigue sur les pages impactées, prends des snapshots, vérifie l'absence d'erreurs console.`,
    )
  }

  return [
    'Tu es un ingénieur senior qui corrige sa propre pull request à partir des retours de revue.',
    "Tu es dans un git worktree positionné sur le HEAD de la branche de la PR (le répertoire courant).",
    '',
    'RÈGLES STRICTES :',
    "- N'exécute AUCUNE commande git (add/commit/push/…). Le moteur s'occupe du commit et du push.",
    "- N'utilise pas le réseau (curl/wget/…) ni de commandes destructives (rm/sudo/…).",
    '- Modifie uniquement les fichiers de ce worktree. Respecte le style de code existant.',
    '',
    'TÂCHES (dans l\'ordre) :',
    ...tasks,
    '',
    '## Retours de revue à traiter',
    brief,
  ].join('\n')
}

function toolInfo(b: any): string {
  const input = b?.input ?? {}
  const v = input.command || input.file_path || input.path || input.pattern || input.url || ''
  return String(v).slice(0, 100)
}

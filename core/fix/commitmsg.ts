import { runClaude } from '../agent/claudeCli'

// Generates one short conventional commit message (feat/fix/refactor/...) from the diff, used by
// "commit and upload".
// On failure/timeout it falls back to a generic string — it must never block the upload.
export async function genCommitMessage(model: string, diff: string): Promise<string> {
  const clipped = diff.length > 60_000 ? diff.slice(0, 60_000) : diff
  if (!clipped.trim()) return 'fix: address review feedback'
  const prompt = `Write ONE concise git commit message in Conventional Commits style (e.g. "fix: ...", "feat: ...", "refactor: ...", "chore: ...") summarizing the diff below.
Output ONLY the single message line — no body, no surrounding quotes, no code fences, under 72 characters.

Diff:
${clipped}`
  try {
    const out = await runClaude(['--print', '--model', model || 'sonnet', '--effort', 'low'], { input: prompt, timeout: 120_000 })
    const msg = (out || '').trim().split('\n')[0]?.replace(/^["'`]+|["'`]+$/g, '').trim()
    return msg || 'fix: address review feedback'
  } catch {
    return 'fix: address review feedback'
  }
}

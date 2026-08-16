import { runClaude } from './claudeCli'

function tryParse(s: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(s) }
  } catch {
    return { ok: false }
  }
}

// Parse agent output into a JSON object. The model occasionally emits invalid JSON (e.g. unescaped code stuffed into the fix field).
// 1) parse directly → 2) extract the outermost {...} → 3) fall back to claude -p to repair it into valid JSON (without rerunning the whole review).
// Note: repairing is mechanical work — always use the fast model + low effort, it **must not follow the project's heavy model/effort** (otherwise even fixing a bit of JSON takes minutes and gets killed by the timeout).
// timeoutMs: timeout of the fallback repair call. Defaults to 120s (enough for review/recheck); paths like feature plan, where
// "the analysis runs for ages and the JSON is only repaired at the very end", pass something longer, so half a day of analysis isn't cut off by the 120s limit at the last step and the whole round wasted.
export async function salvageJson(raw: string, _model?: string, timeoutMs = 120_000): Promise<unknown> {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()

  let r = tryParse(cleaned)
  if (r.ok) return r.value

  const m = cleaned.match(/\{[\s\S]*\}/)
  if (m) {
    r = tryParse(m[0])
    if (r.ok) return r.value
  }

  // Fallback: fast model + low effort to repair it into valid JSON
  const target = m ? m[0] : cleaned
  const prompt = `The following is meant to be a single JSON object but is malformed (likely unescaped quotes/newlines inside string values). Fix it into ONE valid JSON object. Output ONLY the JSON — no code fences, no commentary. Preserve all content; just make it valid JSON.\n\n${target}`
  const stdout = await runClaude(['--print', '--model', 'sonnet', '--effort', 'low'], { input: prompt, timeout: timeoutMs })
  const fixed = String(stdout).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  const fm = fixed.match(/\{[\s\S]*\}/)
  const final = tryParse(fm ? fm[0] : fixed)
  if (final.ok) return final.value
  throw new Error('审核结果 JSON 解析失败，且修复未成功：' + cleaned.slice(0, 200))
}

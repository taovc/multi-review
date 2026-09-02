import { z } from 'zod'

// Structured output for the Claude review family: the zod schema becomes the SDK's `outputFormat: { type: 'json_schema' }`
// and the CLI itself validates (and retries) the final message, delivered as `structured_output` on the result message.
// The text fallback only covers CLIs that do not attach structured_output; there is no LLM "JSON repair" call any more.

export function jsonSchemaFor(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>
  return rest
}

// Strip code fences / stray prose around a JSON object (a CLI without structured output still follows the prompt's
// "only a single JSON object" instruction most of the time).
export function parseJsonLoose(text: string): unknown {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  try { return JSON.parse(cleaned) } catch { /* fall through to the outermost-object scan */ }
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1))
  throw new Error(`no JSON object in the agent's final message (${cleaned.slice(0, 120)}…)`)
}

export function parseStructured<T extends z.ZodType>(schema: T, structured: unknown, text: string): z.infer<T> {
  return schema.parse(unescapeNewlines(structured != null && typeof structured === 'object' ? structured : parseJsonLoose(text)))
}

// Some rounds hand back the two characters `\` `n` where a line break was meant — the prompt asks for "real newlines
// (\n inside the JSON string)" and the model occasionally takes that as the text to write. The result is a wall of
// literal \n in the drawer, and in the comment posted to GitHub, so it is repaired here rather than at each renderer.
//
// Only a field that is ALL escaped — at least one `\n` and not a single real line break — is treated that way. A
// review quotes code for a living, and a finding that mentions \n in a snippet alongside real paragraphs must be left
// exactly as written.
export function unescapeNewlines<T>(value: T): T {
  if (typeof value === 'string') {
    const escaped = value.includes('\\n') // the two characters, not a line break
    return (escaped && !/[\r\n]/.test(value) ? value.replace(/(?:\\r)?\\n/g, '\n') : value) as unknown as T
  }
  if (Array.isArray(value)) return value.map((v) => unescapeNewlines(v)) as unknown as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = unescapeNewlines(v)
    return out as unknown as T
  }
  return value
}

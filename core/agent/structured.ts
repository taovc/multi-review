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
  return schema.parse(structured != null && typeof structured === 'object' ? structured : parseJsonLoose(text))
}

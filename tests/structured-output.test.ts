import assert from 'node:assert/strict'
import { parseJsonLoose, parseStructured, unescapeNewlines } from '../core/agent/structured'
import { z } from 'zod'

// A round sometimes hands back the two characters `\` `n` where a line break was meant, and that text goes straight to
// the drawer and into the comment posted on GitHub. Repaired once at the parse boundary — but only when the field is
// ALL escaped, because a code review quotes code and a snippet mentioning \n beside real paragraphs is written as
// intended.
const BS = String.fromCharCode(92)
const esc = (s: string) => s.split('|').join(BS + 'n')

assert.equal(unescapeNewlines(esc('a|b')), 'a\nb')
assert.equal(unescapeNewlines(esc('para one||para two')), 'para one\n\npara two')
assert.equal(unescapeNewlines('a' + BS + 'r' + BS + 'nb'), 'a\nb', 'escaped CRLF collapses to one break')

const mixed = 'real break\nthen a snippet: ' + BS + 'n.join(parts)'
assert.equal(unescapeNewlines(mixed), mixed, 'a field with real breaks is left exactly as written')
assert.equal(unescapeNewlines('no escapes here'), 'no escapes here')
assert.equal(unescapeNewlines(''), '')

// walks the whole result, leaves non-strings alone
assert.deepEqual(
  unescapeNewlines({ findings: [{ fix: esc('do x|then y'), severity: 'High', introducedByPr: true }], n: 3, z: null }),
  { findings: [{ fix: 'do x\nthen y', severity: 'High', introducedByPr: true }], n: 3, z: null },
)

// and it is applied by the parse boundary itself, for structured output and for the text fallback alike
const S = z.object({ conclusion: z.string() })
assert.equal(parseStructured(S, { conclusion: esc('ok|done') }, '').conclusion, 'ok\ndone')
assert.equal(parseStructured(S, null, JSON.stringify({ conclusion: esc('ok|done') })).conclusion, 'ok\ndone')

// unrelated: the loose parser still strips fences
assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 })

console.log('structured-output: ok')

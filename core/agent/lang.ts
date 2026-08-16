// Working language: AI output (findings / verdicts / fix replies / summaries) follows the
// UI locale of the current instance (#16). Content posted out to GitHub does NOT go through
// here — that path is always translated into professional English.
export type LangCode = 'zh' | 'en' | 'fr'

const LANG_NAME: Record<LangCode, string> = { zh: 'Chinese', en: 'English', fr: 'French' }

// The language every locale-dependent decision falls back to when there is nothing to read:
// a request without the `mr-locale` cookie, an unsupported locale, or a timer-driven job that
// has no user request at all. Matches the frontend's defaultLocale/fallbackLocale in nuxt.config,
// so the UI and the AI working language can never default differently.
export const DEFAULT_LANG: LangCode = 'en'

// Single normalisation entry point for the whole repo. Accepts full locale codes ('fr-FR'),
// unknown values, null and undefined. Never call `lang || 'xx'` at a call site — routing every
// path through here is what keeps the UI language and the AI output language in agreement.
export function resolveLang(code: string | null | undefined): LangCode {
  const two = (code || '').slice(0, 2).toLowerCase()
  return two in LANG_NAME ? (two as LangCode) : DEFAULT_LANG
}

export function langName(code: string | null | undefined): string {
  return LANG_NAME[resolveLang(code)]
}

// Picks the entry matching the working language out of a per-locale table. Use this instead
// of ad-hoc `lang !== 'en'` ternaries, which silently hand French users Chinese text.
export function pickByLang<T>(code: string | null | undefined, table: Record<LangCode, T>): T {
  return table[resolveLang(code)]
}

// Output-language directive appended to agent prompts.
export function outputLangClause(code: string | null | undefined): string {
  return `Write ALL human-readable string values in ${langName(code)}.`
}

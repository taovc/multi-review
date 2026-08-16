// Working language: AI output (findings / verdicts / fix replies / summaries) follows the
// UI locale of the current instance (#16). Content posted out to GitHub does NOT go through
// here — that path is always translated into professional English.
export type LangCode = 'zh' | 'en' | 'fr'

const LANG_NAME: Record<LangCode, string> = { zh: 'Chinese', en: 'English', fr: 'French' }

// Single normalisation entry point. Accepts full locale codes ('fr-FR') and unknown values.
// Unknown / missing falls back to 'zh', matching the `getCookie(event, 'mr-locale') || 'zh'`
// default used by every endpoint, so prompt language and server-side copy never disagree.
export function resolveLang(code: string | null | undefined): LangCode {
  const two = (code || '').slice(0, 2).toLowerCase()
  return two in LANG_NAME ? (two as LangCode) : 'zh'
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

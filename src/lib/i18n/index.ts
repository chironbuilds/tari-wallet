import en from "./en";
import zh from "./zh";
import type { TranslationTree } from "./en";

export type Language = "en" | "zh";

export const LANGUAGE_LABELS: Record<Language, string> = {
  en: "English",
  zh: "中文",
};

/** Every language dictionary must supply exactly the keys `en` does (see `en.ts`'s own doc
 * comment) -- a mapped type over `TranslationTree` rather than a hand-written interface, so
 * adding a key to `en.ts` without adding it to `zh.ts` is a compile error, not a silent runtime
 * fallback discovered later by a Chinese-reading user. */
export type Dictionary = { [K in keyof TranslationTree]: { [L in keyof TranslationTree[K]]: string } };

const DICTIONARIES: Record<Language, Dictionary> = { en, zh };

/** Dot-path key into the dictionary tree, e.g. "home.send" -- derived from `en`'s own shape so a
 * typo'd key is a compile error at the call site, not a runtime "[missing]" string. */
export type TranslationKey = {
  [S in keyof TranslationTree]: `${S & string}.${keyof TranslationTree[S] & string}`;
}[keyof TranslationTree];

let currentLanguage: Language = "en";

/** Set once at popup boot (from `WalletStatus.language`) and again immediately whenever the user
 * switches languages in Settings -- every subsequent `t()` call anywhere in the popup picks it up
 * without needing to be told which language explicitly, since a render function calling `t()`
 * three screens deep has no natural way to thread that through otherwise. */
export function setLanguage(lang: Language): void {
  currentLanguage = lang;
}

export function getLanguage(): Language {
  return currentLanguage;
}

/** Looks up `key` ("screen.key") in the current language's dictionary, substituting `{name}`
 * placeholders from `vars`. Falls back to English for a key some future language hasn't caught up
 * on yet, rather than showing a raw dictionary key or crashing -- English is always complete since
 * every other dictionary is typed against its exact shape (see `Dictionary` above).
 */
export function t(key: TranslationKey, vars?: Record<string, string | number>): string {
  const [section, leaf] = key.split(".") as [keyof TranslationTree, string];
  const dict = DICTIONARIES[currentLanguage] ?? en;
  const template = (dict[section] as Record<string, string> | undefined)?.[leaf] ?? (en[section] as Record<string, string>)[leaf] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
}

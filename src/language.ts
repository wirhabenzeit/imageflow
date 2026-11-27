// The language of a book or of a part of it, as a BCP 47 tag such as `de`, `de-CH` or `en-GB` (API-024). It becomes the
// `lang` attribute of the rendered page, so CSS hyphenation (`hyphens: auto`), quotes and `:lang()` follow it.

/** The tag in its canonical form (`de-ch` → `de-CH`), or undefined when it is not a well-formed BCP 47 language tag. */
export function languageTag(value: unknown): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed || trimmed.length > 64) return undefined;
  try {
    const [canonical] = Intl.getCanonicalLocales(trimmed);
    return canonical;
  } catch {
    return undefined;
  }
}

export const languageHint = "Use a BCP 47 language tag such as 'de', 'de-CH' or 'en-GB'.";

/** The `lang` attribute a platform component renders, or an error that names the component when the tag is malformed. */
export function langAttribute(lang: string | undefined, where: string) {
  if (lang === undefined) return undefined;
  const tag = languageTag(lang);
  if (!tag) throw new Error(where + ' lang ' + JSON.stringify(lang) + ' is not a language tag. ' + languageHint);
  return tag;
}

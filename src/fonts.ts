// The template's bundled fonts, for `fonts` in templates and the Book check's font coverage. The faces come from the
// @font-face rules of the template's stylesheet, as the page uses them; what each face can set comes from its font
// file's character map, read by the app (desktop/fonts.ts), narrowed by the rule's unicode-range when it has one.

export type FontStyle = 'normal' | 'italic';
export type FontQuery = { family: string; weight?: number; style?: FontStyle };
type Face = { family: string; weights: [number, number]; style: FontStyle; ranges?: [number, number][]; unicodeRange?: [number, number][] };

let coverage: Record<string, [number, number][]> = {};
let faces: Face[] | undefined;

/** Set by the render frame from the book's data before the template renders. */
export function setTemplateFonts(next: Record<string, [number, number][]> | undefined) {
  coverage = next ?? {};
  faces = undefined;
}

const unquote = (family: string) => family.trim().replace(/^(['"])(.*)\1$/, '$2');
const weightOf = (value: string): [number, number] => {
  const parts = value.trim().split(/\s+/).map((part) => part === 'bold' ? 700 : part === 'normal' || !part ? 400 : Number(part));
  const [low, high = low] = parts.map((part) => Number.isFinite(part) ? part : 400);
  return [Math.min(low, high), Math.max(low, high)];
};
function unicodeRanges(value: string): [number, number][] | undefined {
  if (!value.trim()) return;
  return value.split(',').map((part) => {
    const range = part.trim().replace(/^u\+/i, '');
    if (range.includes('?')) return [parseInt(range.replace(/\?/g, '0'), 16), parseInt(range.replace(/\?/g, 'f'), 16)];
    const [first, last = first] = range.split('-').map((hex) => parseInt(hex, 16));
    return [first, last];
  });
}

function loadFaces() {
  const found: Face[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try { rules = sheet.cssRules; } catch { continue; }
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSFontFaceRule)) continue;
      const style = rule.style;
      const family = unquote(style.getPropertyValue('font-family'));
      if (!family) continue;
      // The bundled file this face loads: the last path segment of its first url(), as the app serves it.
      const source = /url\(\s*(['"]?)([^'")]+)\1\s*\)/.exec(style.getPropertyValue('src'))?.[2];
      const file = source ? decodeURIComponent(new URL(source, sheet.href ?? location.href).pathname.split('/').pop() ?? '') : '';
      found.push({ family, weights: weightOf(style.getPropertyValue('font-weight')),
        style: /italic|oblique/.test(style.getPropertyValue('font-style')) ? 'italic' : 'normal',
        ranges: coverage[file], unicodeRange: unicodeRanges(style.getPropertyValue('unicode-range')) });
    }
  }
  return found;
}
const allFaces = () => faces ??= loadFaces();

/** The faces that would set `query`, as the browser matches them: its style if there is one, then the closest weight. */
function facesFor({ family, weight = 400, style = 'normal' }: FontQuery) {
  const named = allFaces().filter((face) => face.family.toLowerCase() === family.toLowerCase());
  if (!named.length) return undefined;
  const styled = named.some((face) => face.style === style) ? named.filter((face) => face.style === style) : named;
  const distance = (face: Face) => weight < face.weights[0] ? face.weights[0] - weight : weight > face.weights[1] ? weight - face.weights[1] : 0;
  const best = Math.min(...styled.map(distance));
  // Faces of one weight split by unicode-range together make up the font.
  return styled.filter((face) => distance(face) === best);
}

const inRanges = (code: number, ranges: [number, number][]) => {
  let low = 0, high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (code < ranges[middle][0]) high = middle - 1;
    else if (code > ranges[middle][1]) low = middle + 1;
    else return true;
  }
  return false;
};
// Spaces, line breaks and invisible formatting characters need no glyph of their own.
const invisible = /[\s\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufe00-\ufe0f\ufeff]/u;

/**
 * The characters of `text` that the template's bundled fonts cannot set in `query`'s family, weight and style, each
 * once. Empty when all of them can. Every character is missing for a family the template does not bundle.
 */
export function missingCharacters(text: string, query: FontQuery): string[] {
  const matching = facesFor(query);
  const missing = new Set<string>();
  for (const char of text) {
    if (missing.has(char) || invisible.test(char)) continue;
    const code = char.codePointAt(0)!;
    // A face whose file could not be read is taken to cover what its unicode-range allows.
    const covered = matching?.some((face) => (!face.unicodeRange || inRanges(code, face.unicodeRange)) && (!face.ranges || inRanges(code, face.ranges)));
    if (!covered) missing.add(char);
  }
  return [...missing];
}

/** Whether the template bundles `family` at all. */
export const bundlesFamily = (family: string) => !!facesFor({ family });

/** The bundled faces, one entry per family, weight range and style. */
export function fontList() {
  const seen = new Set<string>();
  return allFaces().flatMap(({ family, weights, style }) => {
    const key = [family, weights.join('-'), style].join('|');
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ family, weight: weights[0] === weights[1] ? weights[0] : weights, style }];
  });
}

/** The `fonts` export of the `imageflow` module. */
export const fonts = {
  list: fontList,
  missing: missingCharacters,
  /** `text` without the characters the fonts cannot set; letters with marks fall back to their base letter (ş → s). */
  settable(text: string, query: FontQuery) {
    const missing = new Set(missingCharacters(text, query));
    if (!missing.size) return text;
    let result = '';
    for (const char of text) {
      if (!missing.has(char)) { result += char; continue; }
      const base = char.normalize('NFD').replace(/\p{M}/gu, '');
      if (base && base !== char && !missingCharacters(base, query).length) result += base;
    }
    return result;
  },
};

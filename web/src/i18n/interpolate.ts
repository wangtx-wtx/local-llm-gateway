/**
 * Placeholder interpolation for translated strings.
 *
 * Kept in its own module — free of React and of the dictionary — so it can be
 * unit tested directly. Interpolation bugs are subtle and language-independent,
 * which makes them exactly the kind of thing worth pinning down with tests.
 */

export type TranslateParams = Record<string, string | number>;

/**
 * Replace `{name}` placeholders with the supplied values.
 *
 * An unknown placeholder is left verbatim rather than replaced with an empty
 * string: a visible `{count}` in the UI is an obvious bug report, whereas a
 * silently blank value looks like a real number that happens to be missing.
 */
export function interpolate(template: string, params?: TranslateParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

/**
 * Extract the placeholder names used by a template, sorted.
 * Used by the dictionary test to keep both languages in sync.
 */
export function placeholders(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? '').sort();
}

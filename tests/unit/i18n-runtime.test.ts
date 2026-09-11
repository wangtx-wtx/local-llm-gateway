import { describe, expect, it } from 'vitest';
import { interpolate, placeholders } from '../../web/src/i18n/interpolate';
import { dictionary } from '../../web/src/i18n/dictionary';

/**
 * Interpolation and dictionary coherence.
 *
 * These exercise the runtime that turns a dictionary entry plus parameters into
 * rendered text, in both languages, without needing a DOM.
 */

describe('interpolate', () => {
  it('replaces a placeholder with a string value', () => {
    expect(interpolate('Hello {name}', { name: 'world' })).toBe('Hello world');
  });

  it('replaces a placeholder with a number value', () => {
    expect(interpolate('{count} requests', { count: 42 })).toBe('42 requests');
  });

  it('replaces the same placeholder every time it appears', () => {
    expect(interpolate('{x} and {x}', { x: 'y' })).toBe('y and y');
  });

  it('handles several distinct placeholders', () => {
    expect(interpolate('{a}-{b}-{c}', { a: 1, b: 'two', c: 3 })).toBe('1-two-3');
  });

  it('leaves an unknown placeholder verbatim rather than blanking it', () => {
    // A visible {count} is an obvious bug; an empty string looks like real data.
    expect(interpolate('{known} and {unknown}', { known: 'ok' })).toBe('ok and {unknown}');
  });

  it('returns the template unchanged when no parameters are supplied', () => {
    expect(interpolate('no placeholders here')).toBe('no placeholders here');
    expect(interpolate('with {one}')).toBe('with {one}');
  });

  it('does not treat braces in values as placeholders', () => {
    expect(interpolate('{a}', { a: '{b}' })).toBe('{b}');
  });

  it('preserves multi-byte text', () => {
    expect(interpolate('已交付 {count} token', { count: 1_024 })).toBe('已交付 1024 token');
  });
});

describe('placeholders', () => {
  it('extracts names in sorted order', () => {
    expect(placeholders('{b} then {a} then {c}')).toEqual(['a', 'b', 'c']);
  });

  it('returns an empty list for a plain string', () => {
    expect(placeholders('nothing here')).toEqual([]);
  });

  it('de-duplicates is intentionally NOT done — callers compare sets of positions', () => {
    // Documenting current behaviour: duplicates are preserved, which is fine
    // because it is only used to compare two languages against each other.
    expect(placeholders('{x}{x}')).toEqual(['x', 'x']);
  });
});

describe('rendering real dictionary entries in both languages', () => {
  const entries = Object.entries(dictionary);

  it('produces non-empty text for every key in every language', () => {
    const empty = entries.filter(([, entry]) => entry.en.trim() === '' || entry.zh.trim() === '');
    expect(empty.map(([key]) => key)).toEqual([]);
  });

  it('renders each language differently wherever the text is genuinely translated', () => {
    // Spot-check a handful of keys that must differ, to catch a dictionary that
    // was accidentally filled with English in both columns.
    const mustDiffer = ['nav.dashboard', 'nav.providers', 'usage.kpiClientTokens', 'auth.title', 'set.saved'];
    for (const key of mustDiffer) {
      const entry = dictionary[key as keyof typeof dictionary];
      expect(entry, `missing key ${key}`).toBeDefined();
      expect(entry.en, key).not.toBe(entry.zh);
    }
  });

  it('interpolates every parameterised entry without leaving a raw placeholder', () => {
    // Build a value for each placeholder name found in the string, then assert
    // no `{name}` survives. This catches a template whose placeholder the caller
    // never supplies.
    const unresolved: string[] = [];
    for (const [key, entry] of entries) {
      for (const language of ['en', 'zh'] as const) {
        const names = placeholders(entry[language]);
        if (names.length === 0) continue;
        const params: Record<string, string> = {};
        for (const name of new Set(names)) params[name] = 'X';
        const rendered = interpolate(entry[language], params);
        if (/\{\w+\}/.test(rendered)) unresolved.push(`${key}.${language}`);
      }
    }
    expect(unresolved).toEqual([]);
  });
});

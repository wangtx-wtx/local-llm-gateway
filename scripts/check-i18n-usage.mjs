/**
 * Detects hardcoded user-visible English in the dashboard.
 *
 * TypeScript already guarantees that every `t('key')` call references a real
 * dictionary entry, and `tests/unit/i18n.test.ts` guarantees the dictionary is
 * complete. The remaining gap is copy that was never wrapped in `t()` at all —
 * that is what this checks.
 *
 * It is a heuristic scanner, so it errs toward under-reporting: only clear
 * user-visible prose is flagged, and genuine code literals (paths, identifiers,
 * sample payloads) are excluded by shape rather than by a long allowlist.
 *
 * Usage:
 *   node scripts/check-i18n-usage.mjs           # report and exit non-zero on findings
 *   node scripts/check-i18n-usage.mjs --list    # also print every candidate considered
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['web/src/views', 'web/src/components', 'web/src/main.tsx'];
const LIST_ALL = process.argv.includes('--list');

/**
 * Attribute values that are user-visible prose when they contain words.
 * Anything not listed here is assumed to be code (className, value, id, ...).
 */
const PROSE_ATTRIBUTES = ['title', 'subtitle', 'label', 'hint', 'placeholder', 'aria-label', 'foot', 'empty'];

/**
 * A candidate is treated as code rather than prose when it looks like one of
 * these. Kept deliberately narrow so real copy is not excused.
 */
function looksLikeCode(text) {
  const value = text.trim();
  if (value === '') return true;
  // Paths, URLs, env vars, HTTP verbs, file names.
  if (/^[\w.-]*\/[\w./{}:-]*$/.test(value)) return true;
  if (/^[A-Z][A-Z0-9_]{2,}$/.test(value)) return true;
  if (/^(https?:|Bearer |sk-|\/v1)/.test(value)) return true;
  // Single tokens: identifiers, enum values, units, model-ish names.
  if (/^[\w.-]+$/.test(value)) return true;
  // Anything with punctuation typical of code rather than prose.
  if (/[{}<>=$`|\\]/.test(value)) return true;
  // Pure numbers / durations / sizes.
  if (/^[\d\s.,:%+-]*(ms|s|m|h|d|B|KB|MB|GB|TB|s)?$/.test(value)) return true;
  // JSON sample payloads.
  if (/^[[{"]/.test(value)) return true;
  return false;
}

/** Text that is clearly prose: two or more words, or a single long word. */
function looksLikeProse(text) {
  const value = text.trim();
  if (looksLikeCode(value)) return false;
  if (!/[a-zA-Z]/.test(value)) return false;
  // TypeScript/JS expressions sitting between two JSX tags are not copy. These
  // markers appear in casts (`x as Record<...>`), comparisons and arrows, never
  // in user-facing prose.
  if (/(\sas\s|=>|\?\.|!=|==|&&|\|\||;\s*$|\btypeof\b|\bvoid\b)/.test(value)) return false;
  const words = value.split(/\s+/).filter((word) => /[a-zA-Z]/.test(word));
  // Two or more words is prose. A single token is left to `looksLikeCode`,
  // which already accepts identifiers and enum values.
  return words.length >= 2;
}

function filesUnder(path) {
  const stats = statSync(path);
  if (stats.isFile()) return [path];
  const out = [];
  for (const entry of readdirSync(path)) {
    const child = join(path, entry);
    if (statSync(child).isDirectory()) out.push(...filesUnder(child));
    else if (/\.tsx?$/.test(entry)) out.push(child);
  }
  return out;
}

/** Strip comments and string-typed code so the scanner sees markup only. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const findings = [];
const considered = [];

for (const file of ROOTS.flatMap(filesUnder)) {
  const source = stripComments(readFileSync(file, 'utf8'));
  const lines = source.split(/\r?\n/);

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    // Skip lines that already route text through the translator.
    if (/\bt\(/.test(line)) return;
    // Skip import/export/type-only plumbing.
    if (/^\s*(import|export|type|\/\/)/.test(line)) return;

    // 1. JSX text nodes: >Some prose<
    for (const match of line.matchAll(/>([^<>{}\n]{3,})</g)) {
      const text = match[1];
      considered.push({ file, lineNumber, text: text.trim(), kind: 'text' });
      if (looksLikeProse(text)) findings.push({ file, lineNumber, text: text.trim(), kind: 'JSX text' });
    }

    // 2. Prose attributes: title="Some prose"
    for (const attribute of PROSE_ATTRIBUTES) {
      // The lookbehind stops `title=` from also matching inside `subtitle=`.
      const pattern = new RegExp(`(?<![A-Za-z-])${attribute}=("([^"]{3,})"|'([^']{3,})')`, 'g');
      for (const match of line.matchAll(pattern)) {
        const text = match[2] ?? match[3] ?? '';
        considered.push({ file, lineNumber, text, kind: attribute });
        if (looksLikeProse(text)) findings.push({ file, lineNumber, text, kind: `${attribute}=` });
      }
    }
  });
}

if (LIST_ALL) {
  process.stdout.write(`\nCandidates considered (${considered.length}):\n`);
  for (const item of considered) {
    process.stdout.write(`  ${item.kind.padEnd(12)} ${item.text}\n`);
  }
}

if (findings.length === 0) {
  process.stdout.write('\nNo hardcoded user-visible English found in the dashboard.\n');
  process.exit(0);
}

process.stdout.write(`\n${findings.length} hardcoded string(s) that need t():\n\n`);
for (const finding of findings) {
  process.stdout.write(`  ${finding.file}:${finding.lineNumber}\n    ${finding.kind}: ${finding.text}\n`);
}
process.stdout.write(
  '\nWrap each in t(\'...\') using a key from web/src/i18n/dictionary.ts.\n' +
    'If a candidate is genuinely not user-visible copy, tighten the heuristic in this script.\n',
);
process.exit(1);

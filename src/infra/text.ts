/**
 * Token estimation used only when a provider does not report usage.
 * Marked as `gateway_estimated` in the accounting layer — never presented as exact.
 */

const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef\uac00-\ud7af]/;

/**
 * Rough tokenizer: CJK characters ≈ 1 token each, other text ≈ 4 chars/token,
 * with a small surcharge for punctuation-heavy content.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if (CJK.test(char)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk + other / 4);
}

/** Estimate the token count of a JSON-serialisable value (tools, schemas, …). */
export function estimateJsonTokens(value: unknown): number {
  try {
    return estimateTokens(JSON.stringify(value) ?? '');
  } catch {
    return 0;
  }
}

import type { CanonicalUsage } from './protocol.js';

/**
 * Token usage helpers with strict null semantics:
 *
 *   null  → the provider did not report this figure ("—" in the UI)
 *   0     → the provider explicitly reported zero
 *
 * Never coerce null to 0 — that is the difference between "no cache used" and
 * "we do not know whether the cache was used".
 */

export function emptyUsage(source: CanonicalUsage['source'] = 'provider'): CanonicalUsage {
  return {
    inputTokens: null,
    cachedInputTokens: null,
    uncachedInputTokens: null,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    totalTokens: null,
    source,
  };
}

export function hasAnyUsage(usage: CanonicalUsage | null | undefined): boolean {
  if (!usage) return false;
  return (
    usage.inputTokens !== null ||
    usage.cachedInputTokens !== null ||
    usage.uncachedInputTokens !== null ||
    usage.cacheCreationInputTokens !== null ||
    usage.cacheReadInputTokens !== null ||
    usage.outputTokens !== null ||
    usage.reasoningTokens !== null ||
    usage.totalTokens !== null
  );
}

/** null-preserving addition: null + x = x, null + null = null. */
function addNullable(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null;
  return (a ?? 0) + (b ?? 0);
}

export function addUsage(a: CanonicalUsage | null, b: CanonicalUsage | null): CanonicalUsage | null {
  if (!a) return b;
  if (!b) return a;
  const source: CanonicalUsage['source'] = a.source === 'provider' && b.source === 'provider' ? 'provider' : 'gateway_estimated';
  return {
    inputTokens: addNullable(a.inputTokens, b.inputTokens),
    cachedInputTokens: addNullable(a.cachedInputTokens, b.cachedInputTokens),
    uncachedInputTokens: addNullable(a.uncachedInputTokens, b.uncachedInputTokens),
    cacheCreationInputTokens: addNullable(a.cacheCreationInputTokens, b.cacheCreationInputTokens),
    cacheReadInputTokens: addNullable(a.cacheReadInputTokens, b.cacheReadInputTokens),
    outputTokens: addNullable(a.outputTokens, b.outputTokens),
    reasoningTokens: addNullable(a.reasoningTokens, b.reasoningTokens),
    totalTokens: addNullable(a.totalTokens, b.totalTokens),
    source,
    ...(a.providerRawUsage || b.providerRawUsage
      ? { providerRawUsage: { ...a.providerRawUsage, ...b.providerRawUsage } }
      : {}),
  };
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Math.trunc(Number(value));
  return null;
}

function pick(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    if (key in record) {
      const value = num(record[key]);
      if (value !== null) return value;
    }
  }
  return null;
}

function pickObject(record: Record<string, unknown>, keys: string[]): Record<string, unknown> | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  }
  return null;
}

/**
 * Map a provider usage object onto canonical usage.
 *
 * Handles the shapes we see in the wild:
 *  - OpenAI chat/responses: { prompt_tokens, completion_tokens, total_tokens,
 *      prompt_tokens_details:{cached_tokens, cache_creation_tokens},
 *      completion_tokens_details:{reasoning_tokens} }
 *  - Anthropic: { input_tokens, output_tokens, cache_creation_input_tokens,
 *      cache_read_input_tokens }
 *  - DeepSeek/Zhipu: { prompt_tokens, completion_tokens, prompt_cache_hit_tokens,
 *      prompt_cache_miss_tokens, completion_tokens_details:{reasoning_tokens} }
 */
export function normalizeProviderUsage(raw: unknown): CanonicalUsage | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;

  const inputTokens = pick(record, ['prompt_tokens', 'input_tokens', 'promptTokens', 'inputTokens']);
  const outputTokens = pick(record, ['completion_tokens', 'output_tokens', 'completionTokens', 'outputTokens']);
  const totalTokensRaw = pick(record, ['total_tokens', 'totalTokens']);

  const promptDetails = pickObject(record, ['prompt_tokens_details', 'input_tokens_details']);
  const completionDetails = pickObject(record, ['completion_tokens_details', 'output_tokens_details']);

  // Cache read tokens: OpenAI's cached_tokens, Anthropic's cache_read_input_tokens,
  // DeepSeek/Zhipu's prompt_cache_hit_tokens.
  const cacheRead = pick(record, ['cache_read_input_tokens', 'cacheReadInputTokens']);
  const cachedFromDetails = promptDetails ? pick(promptDetails, ['cached_tokens', 'cache_read_tokens']) : null;
  const cacheHit = pick(record, ['prompt_cache_hit_tokens']);
  let cachedInputTokens: number | null = cachedFromDetails ?? cacheRead ?? cacheHit;
  if (cachedInputTokens === null && (record['cached_tokens'] !== undefined)) {
    cachedInputTokens = pick(record, ['cached_tokens']);
  }

  // Cache creation (write) tokens: Anthropic only, plus OpenAI's explicit field.
  const cacheCreationInputTokens =
    pick(record, ['cache_creation_input_tokens', 'cacheCreationInputTokens']) ??
    (promptDetails ? pick(promptDetails, ['cache_creation_tokens']) : null) ??
    pick(record, ['prompt_cache_miss_tokens']);

  const reasoningTokens =
    (completionDetails ? pick(completionDetails, ['reasoning_tokens']) : null) ??
    pick(record, ['reasoning_tokens', 'reasoningTokens']);

  let uncachedInputTokens = pick(record, ['uncached_input_tokens', 'prompt_cache_miss_tokens']);
  if (uncachedInputTokens === null && inputTokens !== null && cachedInputTokens !== null) {
    uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens);
  }

  const totalTokens = totalTokensRaw ?? (inputTokens !== null || outputTokens !== null ? (inputTokens ?? 0) + (outputTokens ?? 0) : null);

  const usage: CanonicalUsage = {
    inputTokens,
    cachedInputTokens,
    uncachedInputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens: cacheRead ?? cachedFromDetails,
    outputTokens,
    reasoningTokens,
    totalTokens,
    source: 'provider',
    providerRawUsage: record,
  };

  return hasAnyUsage(usage) ? usage : null;
}

/**
 * Build a usage record when the provider reported nothing: token counts are
 * estimated from the text and the source is marked `gateway_estimated`.
 */
export function estimatedUsage(inputs: {
  inputText?: string;
  outputText?: string;
  estimate: (text: string) => number;
  /** Real usage from the provider, when it exists for parts of the request. */
  partial?: CanonicalUsage | null;
}): CanonicalUsage {
  const partial = inputs.partial ?? null;
  const inputEstimate = inputs.inputText !== undefined ? inputs.estimate(inputs.inputText) : null;
  const outputEstimate = inputs.outputText !== undefined ? inputs.estimate(inputs.outputText) : null;

  const inputTokens = partial?.inputTokens ?? inputEstimate;
  const outputTokens = partial?.outputTokens ?? outputEstimate;
  const totalTokens =
    partial?.totalTokens ?? (inputTokens !== null || outputTokens !== null ? (inputTokens ?? 0) + (outputTokens ?? 0) : null);

  return {
    inputTokens,
    cachedInputTokens: partial?.cachedInputTokens ?? null,
    uncachedInputTokens: partial?.uncachedInputTokens ?? null,
    cacheCreationInputTokens: partial?.cacheCreationInputTokens ?? null,
    cacheReadInputTokens: partial?.cacheReadInputTokens ?? null,
    outputTokens,
    reasoningTokens: partial?.reasoningTokens ?? null,
    totalTokens,
    // Even when individual fields come from the provider, a request whose
    // overall accounting required estimation is labelled as estimated.
    source: 'gateway_estimated',
    ...(partial?.providerRawUsage ? { providerRawUsage: partial.providerRawUsage } : {}),
  };
}

/** Merge a streamed usage event into an existing usage (last write wins per field). */
export function mergeUsage(base: CanonicalUsage | null, update: CanonicalUsage | null): CanonicalUsage | null {
  if (!update) return base;
  if (!base) return update;
  const mergeField = (a: number | null, b: number | null): number | null => (b === null ? a : b);
  const inputTokens = mergeField(base.inputTokens, update.inputTokens);
  const outputTokens = mergeField(base.outputTokens, update.outputTokens);
  // Anthropic streaming reports input usage in message_start and output usage
  // later in message_delta. normalizeProviderUsage derives a partial total for
  // each event, but that derived output-only total must not overwrite the
  // earlier input count. An explicitly reported provider total remains
  // authoritative; otherwise recompute it from the merged fields.
  const raw = update.providerRawUsage;
  const hasExplicitRawTotal = raw !== undefined && ('total_tokens' in raw || 'totalTokens' in raw);
  const totalTokens =
    update.totalTokens !== null && (raw === undefined || hasExplicitRawTotal)
      ? update.totalTokens
      : inputTokens !== null || outputTokens !== null
        ? (inputTokens ?? 0) + (outputTokens ?? 0)
        : mergeField(base.totalTokens, update.totalTokens);
  return {
    inputTokens,
    cachedInputTokens: mergeField(base.cachedInputTokens, update.cachedInputTokens),
    uncachedInputTokens: mergeField(base.uncachedInputTokens, update.uncachedInputTokens),
    cacheCreationInputTokens: mergeField(base.cacheCreationInputTokens, update.cacheCreationInputTokens),
    cacheReadInputTokens: mergeField(base.cacheReadInputTokens, update.cacheReadInputTokens),
    outputTokens,
    reasoningTokens: mergeField(base.reasoningTokens, update.reasoningTokens),
    totalTokens,
    source: base.source === 'provider' && update.source === 'provider' ? 'provider' : 'gateway_estimated',
    ...(base.providerRawUsage || update.providerRawUsage
      ? { providerRawUsage: { ...base.providerRawUsage, ...update.providerRawUsage } }
      : {}),
  };
}

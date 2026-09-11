import { describe, expect, it } from 'vitest';
import {
  addUsage,
  emptyUsage,
  estimatedUsage,
  hasAnyUsage,
  mergeUsage,
  normalizeProviderUsage,
} from '../../src/canonical/usage.js';

/**
 * Usage semantics.
 *
 * The single most important rule: `null` means "the provider did not report
 * this" and `0` means "the provider reported zero". Conflating them silently
 * corrupts every aggregate, so these tests pin the distinction down.
 */

describe('normalizeProviderUsage', () => {
  it('returns null for a missing or non-object usage block', () => {
    expect(normalizeProviderUsage(undefined)).toBeNull();
    expect(normalizeProviderUsage(null)).toBeNull();
    expect(normalizeProviderUsage('nope')).toBeNull();
    expect(normalizeProviderUsage([])).toBeNull();
  });

  it('reads OpenAI chat usage including cached and reasoning details', () => {
    const usage = normalizeProviderUsage({
      prompt_tokens: 100,
      completion_tokens: 40,
      total_tokens: 140,
      prompt_tokens_details: { cached_tokens: 25 },
      completion_tokens_details: { reasoning_tokens: 10 },
    });
    expect(usage).not.toBeNull();
    expect(usage?.inputTokens).toBe(100);
    expect(usage?.outputTokens).toBe(40);
    expect(usage?.totalTokens).toBe(140);
    expect(usage?.cachedInputTokens).toBe(25);
    expect(usage?.reasoningTokens).toBe(10);
    expect(usage?.uncachedInputTokens).toBe(75);
    expect(usage?.source).toBe('provider');
  });

  it('reads Anthropic usage including cache creation/read', () => {
    const usage = normalizeProviderUsage({
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 3,
      cache_read_input_tokens: 7,
    });
    expect(usage?.inputTokens).toBe(10);
    expect(usage?.cacheCreationInputTokens).toBe(3);
    expect(usage?.cacheReadInputTokens).toBe(7);
    // Total is derived when the provider omits it.
    expect(usage?.totalTokens).toBe(15);
  });

  it('preserves an explicitly reported zero instead of treating it as absent', () => {
    const usage = normalizeProviderUsage({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
    expect(usage?.inputTokens).toBe(0);
    expect(usage?.outputTokens).toBe(0);
    // hasAnyUsage must still see this as reported data.
    expect(hasAnyUsage(usage)).toBe(true);
  });

  it('leaves unsupplied fields null rather than zero-filling them', () => {
    const usage = normalizeProviderUsage({ input_tokens: 5 });
    expect(usage?.inputTokens).toBe(5);
    expect(usage?.outputTokens).toBeNull();
    expect(usage?.reasoningTokens).toBeNull();
  });
});

describe('addUsage', () => {
  it('sums reported values', () => {
    const total = addUsage(
      { ...emptyUsage(), inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      { ...emptyUsage(), inputTokens: 4, outputTokens: 6, totalTokens: 10 },
    );
    expect(total?.inputTokens).toBe(14);
    expect(total?.outputTokens).toBe(11);
    expect(total?.totalTokens).toBe(25);
  });

  it('keeps null null when one side never reported the field', () => {
    const total = addUsage(
      { ...emptyUsage(), inputTokens: null, outputTokens: 5 },
      { ...emptyUsage(), inputTokens: 7, outputTokens: null },
    );
    // input reported once → known; output reported once → known.
    expect(total?.inputTokens).toBe(7);
    expect(total?.outputTokens).toBe(5);
  });

  it('returns null when neither side reported anything', () => {
    expect(addUsage(null, null)).toBeNull();
    expect(addUsage(emptyUsage(), emptyUsage())?.inputTokens).toBeNull();
  });

  it('adds zero without turning an unknown into a reported zero', () => {
    const total = addUsage({ ...emptyUsage(), inputTokens: null }, { ...emptyUsage(), inputTokens: 0 });
    // 0 was explicitly reported, so the sum is a known 0 — not null, not unknown.
    expect(total?.inputTokens).toBe(0);
  });

  it('treats gateway_estimated as a distinct source', () => {
    const total = addUsage(
      { ...emptyUsage(), inputTokens: 10, source: 'provider' },
      { ...emptyUsage(), inputTokens: 3, source: 'gateway_estimated' },
    );
    expect(total?.source).toBe('gateway_estimated');
  });
});

describe('estimatedUsage', () => {
  it('labels an estimate as gateway_estimated and never as provider', () => {
    const usage = estimatedUsage({
      inputText: 'hello world, this is a test of the estimator',
      outputText: 'a short reply',
      estimate: (text) => Math.ceil(text.length / 4),
      partial: null,
    });
    expect(usage.source).toBe('gateway_estimated');
    expect(usage.inputTokens).toBeGreaterThan(0);
    expect(usage.outputTokens).toBeGreaterThan(0);
  });

  it('keeps provider-reported fields authoritative when filling gaps', () => {
    const usage = estimatedUsage({
      inputText: 'some input text here',
      outputText: 'output',
      estimate: () => 999,
      partial: { ...emptyUsage(), inputTokens: 42, outputTokens: null, source: 'provider' },
    });
    // The reported input count wins; only the missing field is estimated.
    expect(usage.inputTokens).toBe(42);
    expect(usage.outputTokens).toBeGreaterThan(0);
    expect(usage.source).toBe('gateway_estimated');
  });
});

describe('mergeUsage', () => {
  it('prefers the newer value for each field independently', () => {
    const merged = mergeUsage(
      { ...emptyUsage(), inputTokens: 10, outputTokens: null, totalTokens: null },
      { ...emptyUsage(), inputTokens: null, outputTokens: 7, totalTokens: 17 },
    );
    expect(merged?.inputTokens).toBe(10);
    expect(merged?.outputTokens).toBe(7);
    expect(merged?.totalTokens).toBe(17);
  });

  it('recomputes total when Anthropic streaming reports input and output separately', () => {
    const start = normalizeProviderUsage({ input_tokens: 9, output_tokens: 0 });
    const delta = normalizeProviderUsage({ output_tokens: 4 });
    const merged = mergeUsage(start, delta);
    expect(merged?.inputTokens).toBe(9);
    expect(merged?.outputTokens).toBe(4);
    expect(merged?.totalTokens).toBe(13);
  });
});

describe('emptyUsage', () => {
  it('has every token field null, not zero', () => {
    const usage = emptyUsage();
    expect(usage.inputTokens).toBeNull();
    expect(usage.outputTokens).toBeNull();
    expect(usage.totalTokens).toBeNull();
    expect(usage.cachedInputTokens).toBeNull();
    expect(hasAnyUsage(usage)).toBe(false);
  });
});

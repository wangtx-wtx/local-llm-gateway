import { describe, expect, it } from 'vitest';
import { dictionary, LANGUAGES } from '../../web/src/i18n/dictionary';

/**
 * Dictionary integrity.
 *
 * A half-translated UI is worse than an untranslated one, so these checks make
 * a missing or malformed translation a build failure rather than something a
 * user discovers by switching language.
 */

const entries = Object.entries(dictionary);

describe('i18n dictionary', () => {
  it('defines a non-trivial number of keys', () => {
    expect(entries.length).toBeGreaterThan(300);
  });

  it('has an English string for every key', () => {
    const missing = entries.filter(([, entry]) => typeof entry.en !== 'string' || entry.en.trim() === '');
    expect(missing.map(([key]) => key)).toEqual([]);
  });

  it('has a Chinese string for every key (no untranslated fallbacks)', () => {
    const missing = entries.filter(([, entry]) => typeof entry.zh !== 'string' || entry.zh.trim() === '');
    expect(missing.map(([key]) => key)).toEqual([]);
  });

  it('never leaves Chinese identical to English except for genuine loanwords', () => {
    // A handful of terms are intentionally untranslated because they are proper
    // nouns or wire-protocol names that Chinese-speaking operators also use in
    // English. Anything outside this list is probably an oversight.
    const allowedIdentical = new Set([
      'enum.protocol.openai-chat',
      'enum.protocol.openai-responses',
      'enum.protocol.anthropic-messages',
      'models.chat',
      'models.responses',
      'models.anthropic',
      'sys.node',
      'usage.colRequests',
      'usage.requestsHeader',
      'usage.share',
      'usage.totalTokens',
      'usage.colTotal',
      'usage.inputTokens',
      'usage.outputTokens',
      'usage.reasoningTokens',
      'usage.cachedInputTokens',
      'usage.cacheReadTokens',
      'usage.attemptsLabel',
      'usage.inputTokensBilled',
      'usage.outputTokensBilled',
      'usage.totalTokensBilled',
      'usage.colInput',
      'usage.colOutput',
      'usage.colCached',
      'usage.colReasoning',
      'usage.colFailed',
      'usage.colSuccess',
      'usage.colApiKey',
      'usage.colErrorType',
      'usage.errorType',
      'usage.apiKey',
      'usage.successHeader',
      'common.notReported',
      'sys.scope',
      'sys.limit',
      'sys.required',
      'logs.levelAll',
      'common.allProviders',
      'keys.activeCol',
      'req.attemptNo',
      'req.in',
      'req.out',
      'req.queue',
      'req.result',
      'req.aliasPrefix',
      'models.alias',
      'providers.models',
      'providers.modelsHeading',
      'providers.apiKeysHeading',
      'providers.responsesMode',
      'sys.models',
      'sys.apiKeys',
      'sys.aliases',
      'sys.providers',
      'sys.version',
      'sys.selectable',
      'logs.event',
      'logs.request',
      'logs.level',
      'keys.name',
      'keys.secret',
      'keys.priority',
      'keys.weight',
      'keys.status',
      'common.status',
      'common.name',
      'common.note',
      'common.provider',
      'common.model',
      'common.protocol',
      'common.endpoint',
      'common.actions',
      'common.success',
      'common.total',
      'common.active',
      'dashboard.phase',
      'dashboard.outcome',
      'dashboard.apiKeys',
      'dashboard.openCircuits',
      'dashboard.keyPoolActive',
      'dashboard.limiterActive',
      'dashboard.capacity',
      'dashboard.accounting',
      'set.envAdmin',
      'sys.platform',
      'models.ctx',
      // "ID" and a WAL line built purely from placeholders read the same in both.
      'providers.id',
      'sys.walFoot',
      'sys.journalMode',
      // HTTP header syntax — rendered as literal protocol text in both languages.
      'authKey.bearerLine',
      'authKey.apiKeyLine',
    ]);
    const suspicious = entries
      .filter(([key, entry]) => entry.en === entry.zh && !allowedIdentical.has(key))
      .map(([key]) => key);
    expect(suspicious).toEqual([]);
  });

  it('keeps placeholder names consistent across languages', () => {
    const placeholders = (text: string): string[] =>
      [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? '').sort();

    const mismatched = entries
      .filter(([, entry]) => placeholders(entry.en).join(',') !== placeholders(entry.zh).join(','))
      .map(([key, entry]) => `${key}: en=[${placeholders(entry.en)}] zh=[${placeholders(entry.zh)}]`);

    expect(mismatched).toEqual([]);
  });

  it('uses namespaced keys grouped by view', () => {
    const prefixes = new Set(
      entries.map(([key]) => key.split('.')[0]).filter((prefix): prefix is string => prefix !== undefined),
    );
    // Every key must have a namespace, and the set of namespaces must stay small
    // enough to remain navigable.
    const unnamespaced = entries.filter(([key]) => !key.includes('.')).map(([key]) => key);
    expect(unnamespaced).toEqual([]);
    expect(prefixes.size).toBeLessThan(30);
  });

  it('declares both supported languages', () => {
    expect(LANGUAGES.map((entry) => entry.id).sort()).toEqual(['en', 'zh']);
  });

  it('has no trailing or leading whitespace in translations', () => {
    const padded = entries
      .filter(([, entry]) => entry.en !== entry.en.trim() || entry.zh !== entry.zh.trim())
      .map(([key]) => key);
    expect(padded).toEqual([]);
  });
});

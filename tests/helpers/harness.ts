import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway, type GatewayInstance } from '../../src/bootstrap.js';
import { loadEnv, type GatewayEnv } from '../../src/infra/env.js';
import { createLogger } from '../../src/infra/log.js';
import { defaultModesFor } from '../../src/routing/plan.js';
import { DEFAULT_CAPABILITIES } from '../../src/domain/types.js';
import { FakeProvider, type FakeProviderOptions } from './fake-provider.js';

/**
 * Full-stack test harness: a real gateway (real SQLite, real HTTP server, real
 * key pool) pointed at a mock upstream. Nothing is stubbed in the request path,
 * so these tests exercise SSRF validation, pinned transport, protocol adapters,
 * the orchestrator's retry logic and usage accounting for real.
 */

export interface HarnessOptions {
  fake?: FakeProviderOptions;
  env?: Partial<GatewayEnv>;
  seed?: (gateway: GatewayInstance, fake: FakeProvider) => void;
}

export interface Harness {
  gateway: GatewayInstance;
  fake: FakeProvider;
  url: string;
  /** Seed one provider + N keys + one model and reload the registry. */
  seedChatProvider(input?: {
    keyNames?: string[];
    modelClientId?: string;
    providerName?: string;
    providerId?: string;
    modelId?: string;
    responsesMode?: 'native' | 'emulated' | 'unsupported';
  }): { providerId: string; modelId: string; keyIds: string[] };
  dispose(): Promise<void>;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'llmgw-test-'));
  const fake = new FakeProvider(options.fake ?? {});
  const baseUrl = await fake.start();

  const env: GatewayEnv = {
    // An empty processEnv keeps the developer's real environment out of tests.
    ...loadEnv({}, dir),
    host: '127.0.0.1',
    port: 0,
    dbPath: join(dir, 'gateway.db'),
    // Tests must never pick up the developer's real keys or password.
    gatewayApiKey: null,
    adminPassword: null,
    masterKey: null,
    logLevel: 'error',
    persistLogs: false,
    requestTimeoutMs: 10_000,
    streamIdleTimeoutMs: 10_000,
    connectTimeoutMs: 3_000,
    totalDeadlineMs: 20_000,
    ...options.env,
  };

  const logger = createLogger({ level: env.logLevel });
  const gateway = await createGateway({ env, cwd: dir, logger });

  const harness: Harness = {
    gateway,
    fake,
    url: gateway.address?.url ?? `http://127.0.0.1:${gateway.address?.port ?? 0}`,

    seedChatProvider(input = {}) {
      const { repositories } = gateway;
      const providerId = input.providerId ?? 'prv_test';
      const keyNames = input.keyNames ?? ['Key A'];
      const clientModelId = input.modelClientId ?? 'model-a';
      const modes = defaultModesFor('openai-chat');

      if (!repositories.providers.get(providerId)) {
        repositories.providers.create({
          id: providerId,
          name: input.providerName ?? 'Provider A',
          type: 'openai-compatible',
          baseUrl,
          nativeProtocol: 'openai-chat',
          enabled: true,
          allowPrivateNetwork: true, // the mock upstream listens on loopback
        });
      }

      const keyIds: string[] = [];
      keyNames.forEach((name, index) => {
        const id = `${providerId}_key_${index}`;
        if (!repositories.apiKeys.get(id)) {
          repositories.apiKeys.create({
            id,
            providerId,
            name,
            encryptedSecret: gateway.secretBox.encrypt(`sk-test-${name.replace(/\s+/g, '-').toLowerCase()}`),
            secretMask: `sk-t****${String(index).padStart(4, '0')}`,
            enabled: true,
            priority: 100 - index,
            weight: 1,
          });
        }
        keyIds.push(id);
      });

      const modelId = input.modelId ?? `mdl_${clientModelId.replace(/[^a-z0-9]+/gi, '_')}`;
      if (!repositories.models.get(modelId)) {
        repositories.models.create({
          id: modelId,
          providerId,
          clientModelId,
          upstreamModelId: clientModelId,
          displayName: clientModelId,
          enabled: true,
          contextWindow: 128_000,
          maxOutputTokens: 4_096,
          nativeProtocol: 'openai-chat',
          responsesMode: input.responsesMode ?? modes.responsesMode,
          chatCompletionsMode: modes.chatCompletionsMode,
          anthropicMessagesMode: modes.anthropicMessagesMode,
          capabilities: { ...DEFAULT_CAPABILITIES },
        });
      }

      gateway.registry.reload('test seed');
      return { providerId, modelId, keyIds };
    },

    async dispose() {
      await gateway.close();
      await fake.stop();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort on Windows file locks */
      }
    },
  };

  options.seed?.(gateway, fake);
  return harness;
}

/** POST JSON and parse the JSON reply (non-streaming convenience). */
export async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    /* keep raw text */
  }
  return { status: response.status, body: parsed, headers: response.headers };
}

/** POST and collect the raw SSE text of a streaming response. */
export async function postStream(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string; contentType: string | null }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, text, contentType: response.headers.get('content-type') };
}

export interface ParsedSseEvent {
  event: string | null;
  data: string;
}

/** Parse an SSE body into events (data payloads joined per the SSE spec). */
export function parseSse(text: string): ParsedSseEvent[] {
  const events: ParsedSseEvent[] = [];
  const blocks = text.split(/\r?\n\r?\n/);
  for (const block of blocks) {
    if (block.trim() === '') continue;
    let event: string | null = null;
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    if (dataLines.length > 0) events.push({ event, data: dataLines.join('\n') });
  }
  return events;
}

/** Parse SSE events and JSON-decode each payload. */
export function parseSseJson(text: string): Array<{ event: string | null; json: Record<string, unknown> | null; raw: string }> {
  return parseSse(text).map((entry) => {
    if (entry.data === '[DONE]') return { event: entry.event, json: null, raw: entry.data };
    try {
      return { event: entry.event, json: JSON.parse(entry.data) as Record<string, unknown>, raw: entry.data };
    } catch {
      return { event: entry.event, json: null, raw: entry.data };
    }
  });
}

export async function getJson(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, { headers });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    /* keep raw */
  }
  return { status: response.status, body: parsed };
}

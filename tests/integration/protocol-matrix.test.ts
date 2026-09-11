import { describe, expect, it } from 'vitest';
import type { ProtocolId } from '../../src/domain/types.js';
import { createHarness, postJson, postStream } from '../helpers/harness.js';

const upstreams: Array<{ protocol: ProtocolId; path: string; bodyField: string }> = [
  { protocol: 'openai-chat', path: '/v1/chat/completions', bodyField: 'messages' },
  { protocol: 'openai-responses', path: '/v1/responses', bodyField: 'input' },
  { protocol: 'anthropic-messages', path: '/v1/messages', bodyField: 'messages' },
];

const clients = [
  {
    protocol: 'openai-chat' as const,
    path: '/v1/chat/completions',
    body: { model: 'matrix-model', messages: [{ role: 'user', content: 'matrix test' }] },
    readText(body: unknown): string {
      const value = body as { choices?: Array<{ message?: { content?: string } }> };
      return value.choices?.[0]?.message?.content ?? '';
    },
    streamMarker: 'chat.completion.chunk',
  },
  {
    protocol: 'openai-responses' as const,
    path: '/v1/responses',
    body: { model: 'matrix-model', input: 'matrix test' },
    readText(body: unknown): string {
      return (body as { output_text?: string }).output_text ?? '';
    },
    streamMarker: 'response.completed',
  },
  {
    protocol: 'anthropic-messages' as const,
    path: '/v1/messages',
    body: { model: 'matrix-model', max_tokens: 32, messages: [{ role: 'user', content: 'matrix test' }] },
    readText(body: unknown): string {
      const value = body as { content?: Array<{ type?: string; text?: string }> };
      return value.content?.find((part) => part.type === 'text')?.text ?? '';
    },
    streamMarker: 'message_stop',
  },
];

function collectStreamText(protocol: ProtocolId, stream: string): string {
  let text = '';
  for (const line of stream.split(/\r?\n/)) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6);
    if (payload === '[DONE]') continue;
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (protocol === 'openai-chat') {
      const choices = Array.isArray(value['choices']) ? value['choices'] as Array<Record<string, unknown>> : [];
      const delta = choices[0]?.['delta'] as Record<string, unknown> | undefined;
      if (typeof delta?.['content'] === 'string') text += delta['content'];
    } else if (protocol === 'openai-responses') {
      if (value['type'] === 'response.output_text.delta' && typeof value['delta'] === 'string') text += value['delta'];
    } else {
      const delta = value['delta'] as Record<string, unknown> | undefined;
      if (value['type'] === 'content_block_delta' && delta?.['type'] === 'text_delta' && typeof delta['text'] === 'string') {
        text += delta['text'];
      }
    }
  }
  return text;
}

describe('full 3 x 3 protocol conversion matrix', () => {
  for (const upstream of upstreams) {
    for (const client of clients) {
      const label = `${client.protocol} client -> ${upstream.protocol} upstream`;

      it(`${label}, non-streaming`, async () => {
        const harness = await createHarness({
          fake: { nativeProtocol: upstream.protocol, reply: 'matrix conversion works', usage: { promptTokens: 9, completionTokens: 4 } },
        });
        try {
          harness.seedChatProvider({ nativeProtocol: upstream.protocol, modelClientId: 'matrix-model' });
          const result = await postJson(`${harness.url}${client.path}`, client.body);
          expect(result.status).toBe(200);
          expect(client.readText(result.body)).toContain('matrix conversion works');
          const request = harness.fake.recorded.find((entry) => entry.path === upstream.path);
          expect(request, `expected an upstream request to ${upstream.path}`).toBeDefined();
          expect(request?.body?.[upstream.bodyField]).toBeDefined();
        } finally {
          await harness.dispose();
        }
      }, 20_000);

      it(`${label}, streaming`, async () => {
        const harness = await createHarness({
          fake: { nativeProtocol: upstream.protocol, reply: 'matrix stream works', usage: { promptTokens: 9, completionTokens: 4 } },
        });
        try {
          harness.seedChatProvider({ nativeProtocol: upstream.protocol, modelClientId: 'matrix-model' });
          const result = await postStream(`${harness.url}${client.path}`, { ...client.body, stream: true });
          expect(result.status).toBe(200);
          expect(collectStreamText(client.protocol, result.text)).toBe('matrix stream works');
          expect(result.text).toContain(client.streamMarker);
          const request = harness.fake.recorded.find((entry) => entry.path === upstream.path);
          expect(request, `expected an upstream request to ${upstream.path}`).toBeDefined();
          expect(request?.body?.[upstream.bodyField]).toBeDefined();
          expect(request?.body?.['stream']).toBe(true);
        } finally {
          await harness.dispose();
        }
      }, 20_000);
    }
  }
});

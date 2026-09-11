import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { ProtocolId } from '../../src/domain/types.js';

/**
 * Mock upstream provider used by integration tests and the acceptance test.
 *
 * Speaks OpenAI Chat Completions (streaming and non-streaming) so it can stand
 * in for a "chat-only" provider — exactly the case the Responses compatibility
 * layer must emulate. It records every request (including the auth header) so
 * tests can assert which API key was used and how many attempts were made.
 */

export interface RecordedRequest {
  path: string;
  method: string;
  authorization: string | null;
  apiKeyHeader: string | null;
  body: Record<string, unknown> | null;
  at: number;
}

export interface FakeProviderOptions {
  /** Native wire protocol spoken by this fake upstream. Defaults to OpenAI Chat. */
  nativeProtocol?: ProtocolId;
  /** Reply text streamed back token by token. */
  reply?: string;
  /** Emit reasoning deltas before the text (chat: `reasoning_content`). */
  reasoning?: string;
  /** Tool call to emit instead of / in addition to text. */
  toolCall?: { name: string; arguments: string; id?: string };
  /** Usage reported in the final chunk; set to null to omit usage entirely. */
  usage?: { promptTokens: number; completionTokens: number; cachedTokens?: number; reasoningTokens?: number } | null;
  /** Scripted failures: status → error body, consumed in order per key. */
  failures?: Array<{ status: number; body?: string; headers?: Record<string, string> }>;
  /** Per-credential failures: token suffix → scripted failures. */
  failuresByKey?: Record<string, Array<{ status: number; body?: string; headers?: Record<string, string> }>>;
  /** Delay before the first byte, ms. */
  ttftMs?: number;
  /** Delay between chunks, ms. */
  chunkDelayMs?: number;
  /** Model ids returned by GET /models. */
  models?: string[];  /** Close the stream without a terminator (tests retry-on-partial-stream). */
  truncateStream?: boolean;
  /**
   * Emit a usage frame but no content, then kill the connection — ONCE, so the
   * retry succeeds. Models a provider that bills for a request it never
   * answered, which is the case where upstream-billed tokens legitimately
   * exceed tokens delivered to the client.
   */
  usageThenFailOnce?: boolean;
  /** Ignore the request body's stream flag and always stream / never stream. */
  forceStream?: boolean | null;
}

export class FakeProvider {
  private server: Server | null = null;
  private readonly requests: RecordedRequest[] = [];
  private readonly failureCursor = new Map<string, number>();
  private options: FakeProviderOptions;
  port = 0;

  constructor(options: FakeProviderOptions = {}) {
    this.options = { ...options };
  }

  configure(patch: FakeProviderOptions): void {
    this.options = { ...this.options, ...patch };
    this.failureCursor.clear();
  }

  reset(): void {
    this.requests.length = 0;
    this.failureCursor.clear();
  }

  get recorded(): RecordedRequest[] {
    return [...this.requests];
  }

  get requestCount(): number {
    return this.requests.length;
  }

  /** Distinct credentials seen, in order of first use. */
  get credentialsUsed(): string[] {
    const seen: string[] = [];
    for (const request of this.requests) {
      const credential = request.authorization ?? request.apiKeyHeader ?? '(none)';
      if (!seen.includes(credential)) seen.push(credential);
    }
    return seen;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}/v1`;
  }

  async start(): Promise<string> {
    const server = createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server = server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    this.port = typeof address === 'object' && address ? address.port : 0;
    return this.baseUrl;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    await new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  }

  private async readBody(request: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${this.port}`);
    const raw = await this.readBody(request);
    let body: Record<string, unknown> | null = null;
    if (raw.trim() !== '') {
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        body = null;
      }
    }

    const authorization = typeof request.headers.authorization === 'string' ? request.headers.authorization : null;
    const apiKeyHeader = typeof request.headers['x-api-key'] === 'string' ? request.headers['x-api-key'] : null;
    this.requests.push({
      path: url.pathname,
      method: request.method ?? 'GET',
      authorization,
      apiKeyHeader,
      body,
      at: Date.now(),
    });

    if (url.pathname.endsWith('/models') && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ object: 'list', data: (this.options.models ?? ['model-a']).map((id) => ({ id, object: 'model' })) }));
      return;
    }

    // Scripted failure for this credential, if any.
    const credentialToken = (authorization ?? apiKeyHeader ?? '').replace(/^Bearer\s+/i, '');
    const scriptKey = Object.keys(this.options.failuresByKey ?? {}).find((key) => credentialToken.endsWith(key));
    const script = (scriptKey ? this.options.failuresByKey?.[scriptKey] : undefined) ?? this.options.failures;
    if (script && script.length > 0) {
      const cursorKey = scriptKey ?? '*';
      const index = this.failureCursor.get(cursorKey) ?? 0;
      if (index < script.length) {
        this.failureCursor.set(cursorKey, index + 1);
        const failure = script[index];
        if (failure) {
          response.writeHead(failure.status, {
            'content-type': 'application/json',
            ...failure.headers,
          });
          response.end(
            failure.body ??
              JSON.stringify({ error: { message: `Simulated upstream failure ${failure.status}`, type: 'error', code: String(failure.status) } }),
          );
          return;
        }
      }
    }

    const wantsStream = this.options.forceStream ?? (body?.['stream'] === true);
    if (wantsStream) {
      await this.streamResponse(request, response, body);
      return;
    }
    await this.jsonResponse(response, body);
  }

  private usagePayload(): Record<string, unknown> | null {
    const usage = this.options.usage === undefined ? { promptTokens: 12, completionTokens: 7 } : this.options.usage;
    if (!usage) return null;
    const payload: Record<string, unknown> = {
      prompt_tokens: usage.promptTokens,
      completion_tokens: usage.completionTokens,
      total_tokens: usage.promptTokens + usage.completionTokens,
    };
    if (usage.cachedTokens !== undefined) {
      payload['prompt_tokens_details'] = { cached_tokens: usage.cachedTokens };
    }
    if (usage.reasoningTokens !== undefined) {
      payload['completion_tokens_details'] = { reasoning_tokens: usage.reasoningTokens };
    }
    return payload;
  }

  private async jsonResponse(response: ServerResponse, body: Record<string, unknown> | null): Promise<void> {
    const nativeProtocol = this.options.nativeProtocol ?? 'openai-chat';
    if (nativeProtocol === 'openai-responses') {
      this.responsesJsonResponse(response, body);
      return;
    }
    if (nativeProtocol === 'anthropic-messages') {
      this.anthropicJsonResponse(response, body);
      return;
    }
    const message: Record<string, unknown> = { role: 'assistant', content: this.options.reply ?? 'Hello from the fake provider.' };
    if (this.options.reasoning) message['reasoning_content'] = this.options.reasoning;
    if (this.options.toolCall) {
      message['content'] = null;
      message['tool_calls'] = [
        {
          id: this.options.toolCall.id ?? 'call_fake_1',
          type: 'function',
          function: { name: this.options.toolCall.name, arguments: this.options.toolCall.arguments },
        },
      ];
    }
    const payload: Record<string, unknown> = {
      id: 'chatcmpl-fake-1',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: typeof body?.['model'] === 'string' ? body['model'] : 'model-a',
      choices: [
        {
          index: 0,
          message,
          finish_reason: this.options.toolCall ? 'tool_calls' : 'stop',
        },
      ],
    };
    const usage = this.usagePayload();
    if (usage) payload['usage'] = usage;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(payload));
  }

  private responsesJsonResponse(response: ServerResponse, body: Record<string, unknown> | null): void {
    const text = this.options.reply ?? 'Hello from the fake provider.';
    const model = typeof body?.['model'] === 'string' ? body['model'] : 'model-a';
    const usage = this.options.usage === undefined ? { promptTokens: 12, completionTokens: 7 } : this.options.usage;
    const payload = {
      id: 'resp_fake_1',
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status: 'completed',
      model,
      output: [
        {
          id: 'msg_fake_1',
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text, annotations: [] }],
        },
      ],
      output_text: text,
      usage: usage
        ? { input_tokens: usage.promptTokens, output_tokens: usage.completionTokens, total_tokens: usage.promptTokens + usage.completionTokens }
        : null,
    };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(payload));
  }

  private anthropicJsonResponse(response: ServerResponse, body: Record<string, unknown> | null): void {
    const text = this.options.reply ?? 'Hello from the fake provider.';
    const model = typeof body?.['model'] === 'string' ? body['model'] : 'model-a';
    const usage = this.options.usage === undefined ? { promptTokens: 12, completionTokens: 7 } : this.options.usage;
    const payload = {
      id: 'msg_fake_1',
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: usage ? { input_tokens: usage.promptTokens, output_tokens: usage.completionTokens } : { input_tokens: 0, output_tokens: 0 },
    };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(payload));
  }

  private async streamResponse(
    request: IncomingMessage,
    response: ServerResponse,
    body: Record<string, unknown> | null,
  ): Promise<void> {
    const nativeProtocol = this.options.nativeProtocol ?? 'openai-chat';
    if (nativeProtocol === 'openai-responses') {
      await this.responsesStreamResponse(response, body);
      return;
    }
    if (nativeProtocol === 'anthropic-messages') {
      await this.anthropicStreamResponse(response, body);
      return;
    }
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    const model = typeof body?.['model'] === 'string' ? body['model'] : 'model-a';
    const id = `chatcmpl-fake-${Date.now().toString(36)}`;
    const created = Math.floor(Date.now() / 1000);
    const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

    const write = (payload: unknown): boolean =>
      response.write(`data: ${JSON.stringify(payload)}\n\n`);

    const chunk = (delta: Record<string, unknown>, finishReason: string | null = null, includeUsage = false): Record<string, unknown> => {
      const payload: Record<string, unknown> = {
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [
          {
            index: 0,
            delta,
            finish_reason: finishReason,
          },
        ],
      };
      if (includeUsage) payload['usage'] = this.usagePayload();
      return payload;
    };

    if (this.options.ttftMs) await sleep(this.options.ttftMs);

    write(chunk({ role: 'assistant', content: '' }));

    if (this.options.usageThenFailOnce) {
      // Usage is billed, but no content ever arrives. Consumed on first use so
      // the retry can succeed.
      this.options.usageThenFailOnce = false;
      write(chunk({}, null, true));
      await sleep(30);
      response.destroy();
      return;
    }

    if (this.options.reasoning) {
      for (const token of this.options.reasoning.match(/\S+\s*/g) ?? []) {
        write(chunk({ reasoning_content: token }));
        if (this.options.chunkDelayMs) await sleep(this.options.chunkDelayMs);
      }
    }

    if (this.options.toolCall) {
      write(
        chunk({
          tool_calls: [
            {
              index: 0,
              id: this.options.toolCall.id ?? 'call_fake_1',
              type: 'function',
              function: { name: this.options.toolCall.name, arguments: '' },
            },
          ],
        }),
      );
      // Stream arguments as fragments, never as one complete JSON blob.
      const args = this.options.toolCall.arguments;
      const step = Math.max(1, Math.ceil(args.length / 3));
      for (let index = 0; index < args.length; index += step) {
        write(chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(index, index + step) } }] }));
        if (this.options.chunkDelayMs) await sleep(this.options.chunkDelayMs);
      }
      if (this.options.truncateStream) {
        // Give the socket a moment to flush what was written: destroy() would
        // otherwise discard the buffered chunks and produce an empty body
        // instead of a genuine "stream died after partial output" scenario.
        await sleep(30);
        response.destroy();
        return;
      }
      write(chunk({}, 'tool_calls', true));
    } else {
      const reply = this.options.reply ?? 'Hello from the fake provider.';
      for (const token of reply.match(/\S+\s*/g) ?? [reply]) {
        write(chunk({ content: token }));
        if (this.options.chunkDelayMs) await sleep(this.options.chunkDelayMs);
      }
      if (this.options.truncateStream) {
        await sleep(30);
        response.destroy();
        return;
      }
      write(chunk({}, 'stop', true));
    }

    response.write('data: [DONE]\n\n');
    response.end();
    void request;
  }

  private async responsesStreamResponse(response: ServerResponse, body: Record<string, unknown> | null): Promise<void> {
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
    const model = typeof body?.['model'] === 'string' ? body['model'] : 'model-a';
    const text = this.options.reply ?? 'Hello from the fake provider.';
    const usage = this.options.usage === undefined ? { promptTokens: 12, completionTokens: 7 } : this.options.usage;
    const id = `resp_fake_${Date.now().toString(36)}`;
    const itemId = `msg_fake_${Date.now().toString(36)}`;
    let sequence = 0;
    const write = (type: string, fields: Record<string, unknown>): void => {
      response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields, sequence_number: sequence++ })}\n\n`);
    };
    const envelope = {
      id,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status: 'completed',
      model,
      output: [{ id: itemId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }],
      output_text: text,
      usage: usage ? { input_tokens: usage.promptTokens, output_tokens: usage.completionTokens, total_tokens: usage.promptTokens + usage.completionTokens } : null,
    };
    write('response.created', { response: { ...envelope, status: 'in_progress', output: [], output_text: '', usage: null } });
    write('response.output_item.added', { output_index: 0, item: { id: itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] } });
    for (const token of text.match(/\S+\s*/g) ?? [text]) {
      write('response.output_text.delta', { item_id: itemId, output_index: 0, content_index: 0, delta: token });
    }
    write('response.output_text.done', { item_id: itemId, output_index: 0, content_index: 0, text });
    write('response.output_item.done', { output_index: 0, item: envelope.output[0] });
    write('response.completed', { response: envelope });
    response.end();
  }

  private async anthropicStreamResponse(response: ServerResponse, body: Record<string, unknown> | null): Promise<void> {
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
    const model = typeof body?.['model'] === 'string' ? body['model'] : 'model-a';
    const text = this.options.reply ?? 'Hello from the fake provider.';
    const usage = this.options.usage === undefined ? { promptTokens: 12, completionTokens: 7 } : this.options.usage;
    const write = (type: string, fields: Record<string, unknown>): void => {
      response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
    };
    write('message_start', {
      message: {
        id: `msg_fake_${Date.now().toString(36)}`,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: usage?.promptTokens ?? 0, output_tokens: 0 },
      },
    });
    write('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    for (const token of text.match(/\S+\s*/g) ?? [text]) {
      write('content_block_delta', { index: 0, delta: { type: 'text_delta', text: token } });
    }
    write('content_block_stop', { index: 0 });
    write('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: usage?.completionTokens ?? 0 } });
    write('message_stop', {});
    response.end();
  }
}

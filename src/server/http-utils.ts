import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';

/**
 * Minimal HTTP plumbing shared by the gateway and admin surfaces. There is no
 * web framework here on purpose: SSE framing, backpressure and abort propagation
 * must stay under explicit control.
 */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

export interface ReadBodyOptions {
  maxBytes: number;
  signal?: AbortSignal;
}

/** Buffer a request body with a hard size cap. */
export function readBody(req: IncomingMessage, options: ReadBodyOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const onData = (chunk: Buffer): void => {
      total += chunk.length;
      if (total > options.maxBytes) {
        cleanup();
        req.destroy();
        reject(new HttpError(413, `Request body exceeds the ${options.maxBytes} byte limit`));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(new HttpError(400, `Failed to read request body: ${error.message}`));
    };
    const onAbort = (): void => {
      cleanup();
      reject(new HttpError(499, 'Client disconnected while sending the request body'));
    };
    const cleanup = (): void => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      options.signal?.removeEventListener('abort', onAbort);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

export function parseJsonBody(buffer: Buffer): unknown {
  if (buffer.length === 0) return undefined;
  const text = buffer.toString('utf8').trim();
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new HttpError(400, `Invalid JSON body: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Header lookup that tolerates Node's string | string[] representation. */
export function headerValue(headers: IncomingHttpHeaders, name: string): string | null {
  const raw = headers[name.toLowerCase()];
  if (raw === undefined) return null;
  if (Array.isArray(raw)) return raw[0] ?? null;
  return raw;
}

export interface CredentialInput {
  headers: IncomingHttpHeaders;
  /** `?api_key=` and `?password=` are accepted for SSE clients that cannot set headers. */
  query: URLSearchParams;
}

/** Extract a bearer token / x-api-key style credential from a request. */
export function extractCredential(input: CredentialInput, names: string[]): string | null {
  const authorization = headerValue(input.headers, 'authorization');
  if (authorization) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match && match[1]) return match[1].trim();
  }
  for (const name of names) {
    const value = headerValue(input.headers, name);
    if (value && value.trim() !== '') return value.trim();
  }
  const queryValue = input.query.get(names[0] ?? 'api_key') ?? input.query.get('api_key') ?? input.query.get('password');
  if (queryValue && queryValue.trim() !== '') return queryValue.trim();
  return null;
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.startsWith('::ffff:') ? address.slice(7) : address;
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost';
}

export function wantsEventStream(headers: IncomingHttpHeaders, body: unknown): boolean {
  if (typeof body === 'object' && body !== null && (body as { stream?: unknown }).stream === true) return true;
  const accept = headerValue(headers, 'accept') ?? '';
  return accept.includes('text/event-stream');
}

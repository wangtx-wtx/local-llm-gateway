import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';

import { GatewayError, classifyTransportError, gatewayErrors } from '../errors/gateway-error.js';
import type { ValidatedTarget } from '../security/ssrf.js';

/**
 * HTTP client for upstream providers.
 *
 * Unlike fetch(), this client connects to a pre-validated IP address while
 * sending the original Host header and TLS SNI, which closes the DNS-rebinding
 * window between the SSRF check and the TCP connect.
 *
 * It also gives precise control over connect / headers / stream-idle timeouts
 * and abort propagation, which upstream streaming depends on.
 */

export interface PinnedRequestOptions {
  method: string;
  target: ValidatedTarget;
  path?: string;
  headers: Record<string, string>;
  body?: string;
  connectTimeoutMs: number;
  headersTimeoutMs: number;
  signal?: AbortSignal;
  label: string;
}

export interface PinnedResponse {
  status: number;
  statusText: string;
  headers: IncomingHttpHeaders;
  /** Response body stream (SSE-friendly: never buffered by the transport). */
  stream: IncomingMessage;
  /** The concrete address that served the response. */
  address: string;
  setIdleTimeout(ms: number): void;
  clearIdleTimeout(): void;
  destroy(error?: Error): void;
}

function hostHeaderFor(hostname: string, port: number, tls: boolean): string {
  const isIpv6 = hostname.includes(':');
  const host = isIpv6 ? `[${hostname}]` : hostname;
  const isDefaultPort = (tls && port === 443) || (!tls && port === 80);
  return isDefaultPort ? host : `${host}:${port}`;
}

function isIpLiteral(hostname: string): boolean {
  return /^[0-9.]+$/.test(hostname) || hostname.includes(':');
}

export async function pinnedRequest(options: PinnedRequestOptions): Promise<PinnedResponse> {
  const { target, label } = options;
  const path = options.path ?? `${target.url.pathname}${target.url.search}`;
  const hostHeader = hostHeaderFor(target.hostname, target.port, target.tls);
  const requestFn = target.tls ? httpsRequest : httpRequest;

  let lastError: GatewayError | null = null;

  for (const candidate of target.addresses) {
    try {
      return await attemptAddress(candidate.address, candidate.family);
    } catch (err) {
      const gatewayError = err instanceof GatewayError ? err : classifyTransportError(err, label);
      lastError = gatewayError;
      if (gatewayError.details['responseStarted'] === true) throw gatewayError;
      if (options.signal?.aborted) throw gatewayError;
      // else: try the next resolved address (connect-phase failure only)
    }
  }

  throw lastError ?? gatewayErrors.network(`${label} could not be reached`);

  function attemptAddress(address: string, family: 4 | 6): Promise<PinnedResponse> {
    return new Promise<PinnedResponse>((resolve, reject) => {
      const headers: Record<string, string> = { host: hostHeader, ...options.headers };
      if (options.body !== undefined && headers['content-length'] === undefined) {
        headers['content-length'] = String(Buffer.byteLength(options.body, 'utf8'));
      }

      const requestOptions: RequestOptions = {
        host: address,
        family,
        port: target.port,
        method: options.method,
        path,
        headers,
        agent: false,
        ...(target.tls && !isIpLiteral(target.hostname) ? { servername: target.hostname } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      };

      let settled = false;
      let responseStarted = false;
      let connectTimer: NodeJS.Timeout | null = null;
      let headersTimer: NodeJS.Timeout | null = null;
      let currentRes: IncomingMessage | null = null;

      const clearTimers = (): void => {
        if (connectTimer) {
          clearTimeout(connectTimer);
          connectTimer = null;
        }
        if (headersTimer) {
          clearTimeout(headersTimer);
          headersTimer = null;
        }
      };

      const fail = (error: GatewayError): void => {
        clearTimers();
        if (settled) {
          currentRes?.destroy(error);
          return;
        }
        settled = true;
        if (responseStarted) error.details['responseStarted'] = true;
        reject(error);
        // Destroying the request after rejection cleans up the socket.
        try {
          req.destroy();
        } catch {
          /* ignore */
        }
      };

      const req = requestFn(requestOptions, (res: IncomingMessage) => {
        responseStarted = true;
        clearTimers();
        currentRes = res;
        if (settled) {
          res.destroy();
          return;
        }
        settled = true;

        res.on('error', () => {
          /* consumer observes stream errors through the pipeline */
        });

        resolve({
          status: res.statusCode ?? 0,
          statusText: res.statusMessage ?? '',
          headers: res.headers,
          stream: res,
          address,
          setIdleTimeout(ms: number): void {
            const socket = res.socket;
            if (!socket) return;
            const onTimeout = (): void => {
              socket.destroy(
                new GatewayError('timeout_error', {
                  message: `Upstream stream idle for more than ${ms}ms`,
                  details: { code: 'STREAM_IDLE_TIMEOUT', idleTimeoutMs: ms },
                }),
              );
            };
            socket.setTimeout(ms);
            socket.once('timeout', onTimeout);
            res.once('close', () => socket.removeListener('timeout', onTimeout));
          },
          clearIdleTimeout(): void {
            res.socket?.setTimeout(0);
          },
          destroy(error?: Error): void {
            try {
              req.destroy(error);
            } catch {
              /* ignore */
            }
            res.destroy(error);
          },
        });
      });

      req.on('error', (err: Error) => {
        clearTimers();
        if (settled) {
          currentRes?.destroy(err instanceof GatewayError ? err : classifyTransportError(err, label));
          return;
        }
        settled = true;
        let gatewayError: GatewayError;
        if (options.signal?.aborted) {
          gatewayError = new GatewayError('client_disconnected_error', {
            message: `${label} request aborted`,
            cause: err,
            details: { aborted: true, responseStarted },
          });
        } else {
          gatewayError = classifyTransportError(err, label);
          gatewayError.details['responseStarted'] = responseStarted;
        }
        reject(gatewayError);
      });

      req.on('socket', (socket) => {
        socket.once('connect', () => {
          if (settled || responseStarted) return;
          if (connectTimer) {
            clearTimeout(connectTimer);
            connectTimer = null;
          }
          headersTimer = setTimeout(() => {
            fail(
              new GatewayError('timeout_error', {
                message: `${label} did not return response headers within ${options.headersTimeoutMs}ms`,
                details: { phase: 'headers', timeoutMs: options.headersTimeoutMs },
              }),
            );
          }, options.headersTimeoutMs);
        });
      });

      connectTimer = setTimeout(() => {
        fail(
          new GatewayError('timeout_error', {
            message: `${label} connect timeout after ${options.connectTimeoutMs}ms`,
            details: { phase: 'connect', timeoutMs: options.connectTimeoutMs },
          }),
        );
      }, options.connectTimeoutMs);

      if (options.body !== undefined) req.write(options.body, 'utf8');
      req.end();
    });
  }
}

/** Read a bounded amount of an incoming stream as text (for error bodies). */
export async function readStreamText(stream: NodeJS.ReadableStream, limit = 64 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  return await new Promise<string>((resolve, reject) => {
    stream.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      total += buf.length;
      if (total > limit) {
        chunks.push(buf.subarray(0, Math.max(0, buf.length - (total - limit))));
        resolve(Buffer.concat(chunks).toString('utf8'));
        (stream as { destroy?: (error?: Error) => void }).destroy?.();
        return;
      }
      chunks.push(buf);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
}

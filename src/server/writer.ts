import { createReadStream } from 'node:fs';
import type { ServerResponse } from 'node:http';

/**
 * Response writing with real backpressure.
 *
 * `res.write()` returning false means the kernel/socket buffer is full; we await
 * 'drain' instead of queueing unboundedly in memory. Every wait is abort-aware
 * so a slow or vanished client releases the upstream stream promptly.
 */

export class ClientGoneError extends Error {
  constructor(message = 'Client disconnected') {
    super(message);
    this.name = 'ClientGoneError';
  }
}

export class ResponseWriter {
  private headersSent = false;
  private finished = false;
  private bytesWritten = 0;

  constructor(
    private readonly res: ServerResponse,
    private readonly signal: AbortSignal,
  ) {}

  get sent(): boolean {
    return this.headersSent;
  }

  get bytes(): number {
    return this.bytesWritten;
  }

  get closed(): boolean {
    return this.finished || this.res.writableEnded;
  }

  private assertOpen(): void {
    if (this.signal.aborted) throw new ClientGoneError();
    if (this.finished) throw new ClientGoneError('Response already finished');
  }

  setHeader(name: string, value: string): void {
    if (this.headersSent) return;
    this.res.setHeader(name, value);
  }

  json(status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
    if (this.headersSent) return;
    const payload = JSON.stringify(body ?? null);
    this.headersSent = true;
    this.res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
      'cache-control': 'no-store',
      ...extraHeaders,
    });
    this.finished = true;
    this.res.end(payload);
  }

  text(status: number, body: string, extraHeaders: Record<string, string> = {}): void {
    if (this.headersSent) return;
    this.headersSent = true;
    this.res.writeHead(status, {
      'content-type': 'text/plain; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      ...extraHeaders,
    });
    this.finished = true;
    this.res.end(body);
  }

  /** Begin an SSE response. Idempotent. */
  startEventStream(extraHeaders: Record<string, string> = {}): void {
    if (this.headersSent) return;
    this.headersSent = true;
    this.res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Disable proxy buffering so tokens are not held back.
      'x-accel-buffering': 'no',
      ...extraHeaders,
    });
    this.res.flushHeaders?.();
  }

  /** Write raw bytes, awaiting drain when the socket is saturated. */
  async write(chunk: string | Buffer): Promise<void> {
    this.assertOpen();
    if (this.res.writableEnded) throw new ClientGoneError();
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    if (buffer.length === 0) return;
    // A write implicitly flushes headers; record that so callers never attempt
    // a second writeHead on the same response.
    this.headersSent = true;
    const accepted = this.res.write(buffer);
    this.bytesWritten += buffer.length;
    if (!accepted) await this.waitForDrain();
  }

  private waitForDrain(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const response = this.res;
      const onDrain = (): void => {
        cleanup();
        resolve();
      };
      const onClose = (): void => {
        cleanup();
        reject(new ClientGoneError('Client disconnected while the response buffer was full'));
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const onAbort = (): void => {
        cleanup();
        reject(new ClientGoneError());
      };
      const cleanup = (): void => {
        response.off('drain', onDrain);
        response.off('close', onClose);
        response.off('error', onError);
        this.signal.removeEventListener('abort', onAbort);
      };
      response.once('drain', onDrain);
      response.once('close', onClose);
      response.once('error', onError);
      this.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  end(): void {
    if (this.finished || this.res.writableEnded) return;
    this.finished = true;
    this.res.end();
  }

  /**
   * Stream a file straight to the socket (dashboard assets). Bypasses the
   * backpressure helper because the kernel handles file→socket piping.
   */
  sendFile(path: string, headers: Record<string, string>): void {
    if (this.headersSent) return;
    this.headersSent = true;
    this.finished = true;
    this.res.writeHead(200, headers);
    const stream = createReadStream(path);
    stream.on('error', () => this.res.destroy());
    stream.pipe(this.res);
  }

  /** Terminate the connection without a graceful finish (used on hard aborts). */
  destroy(): void {
    if (this.finished) return;
    this.finished = true;
    this.res.destroy();
  }
}

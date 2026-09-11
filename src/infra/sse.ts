/**
 * Server-Sent Events codec.
 *
 * The parser is byte-oriented: it feeds a streaming TextDecoder so that
 * multi-byte UTF-8 sequences split across TCP chunks are reassembled before
 * any JSON parsing happens, and it buffers partial frames until the blank line
 * terminator arrives.
 */

export const SSE_DONE = '[DONE]';

export interface SseMessage {
  /** `event:` field, when present. */
  event?: string;
  /** `data:` field(s) joined with newlines. */
  data: string;
  /** `id:` field, when present. */
  id?: string;
  /** `retry:` field, when present. */
  retry?: number;
  /** Raw frame text (for debug snapshots). */
  raw: string;
}

export class SseParser {
  private readonly decoder = new TextDecoder('utf-8', { fatal: false });
  private buffer = '';
  private current: { event?: string; data: string[]; id?: string; retry?: number; raw: string[] } | null = null;

  /** Feed a chunk of bytes (or already-decoded text) and return complete messages. */
  feed(chunk: Uint8Array | string): SseMessage[] {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    const out: SseMessage[] = [];
    // Normalise CRLF / CR to LF so frame splitting is uniform.
    this.buffer = this.buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    let index = this.buffer.indexOf('\n');
    while (index !== -1) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      const message = this.consumeLine(line);
      if (message) out.push(message);
      index = this.buffer.indexOf('\n');
    }
    return out;
  }

  /** Flush any trailing frame (used when the stream ends without a blank line). */
  flush(): SseMessage[] {
    this.buffer += this.decoder.decode();
    const out: SseMessage[] = [];
    const rest = this.buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    this.buffer = '';
    for (const line of rest.split('\n')) {
      const message = this.consumeLine(line);
      if (message) out.push(message);
    }
    const pending = this.finalize();
    if (pending) out.push(pending);
    return out;
  }

  private consumeLine(line: string): SseMessage | null {
    if (line.length === 0) {
      return this.finalize();
    }
    if (line.startsWith(':')) {
      // comment / heartbeat
      if (this.current) this.current.raw.push(line);
      return null;
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (!this.current) this.current = { data: [], raw: [] };
    this.current.raw.push(line);
    switch (field) {
      case 'event':
        this.current.event = value;
        break;
      case 'data':
        this.current.data.push(value);
        break;
      case 'id':
        this.current.id = value;
        break;
      case 'retry': {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed)) this.current.retry = parsed;
        break;
      }
      default:
        break;
    }
    return null;
  }

  private finalize(): SseMessage | null {
    const current = this.current;
    this.current = null;
    if (!current) return null;
    if (current.data.length === 0 && current.event === undefined && current.id === undefined) return null;
    return {
      ...(current.event !== undefined ? { event: current.event } : {}),
      data: current.data.join('\n'),
      ...(current.id !== undefined ? { id: current.id } : {}),
      ...(current.retry !== undefined ? { retry: current.retry } : {}),
      raw: current.raw.join('\n'),
    };
  }
}

export interface SseFrame {
  event?: string;
  data: string;
  id?: string;
}

/** Encode one SSE frame. */
export function encodeSseFrame(frame: SseFrame): string {
  const parts: string[] = [];
  if (frame.id !== undefined) parts.push(`id: ${frame.id}`);
  if (frame.event !== undefined) parts.push(`event: ${frame.event}`);
  for (const line of frame.data.split('\n')) parts.push(`data: ${line}`);
  return `${parts.join('\n')}\n\n`;
}

/** Encode a JSON payload as one SSE frame. */
export function encodeSseJson(event: string | undefined, payload: unknown, id?: string): string {
  return encodeSseFrame({
    ...(event !== undefined ? { event } : {}),
    ...(id !== undefined ? { id } : {}),
    data: JSON.stringify(payload),
  });
}

/**
 * Try to parse an SSE data payload as JSON.
 * Returns null for the [DONE] sentinel and for malformed payloads, so callers
 * can decide whether to skip (chat) or fail (responses).
 */
export function parseSseJson(message: SseMessage): { kind: 'done' } | { kind: 'json'; value: unknown } | { kind: 'invalid'; raw: string } {
  const data = message.data.trim();
  if (data === SSE_DONE || data === '') return { kind: 'done' };
  try {
    return { kind: 'json', value: JSON.parse(data) as unknown };
  } catch {
    return { kind: 'invalid', raw: message.data };
  }
}

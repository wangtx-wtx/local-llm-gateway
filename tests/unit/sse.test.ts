import { describe, expect, it } from 'vitest';
import { SseParser, encodeSseFrame, encodeSseJson, parseSseJson } from '../../src/infra/sse.js';

describe('SseParser', () => {
  it('parses a simple event', () => {
    const parser = new SseParser();
    const events = parser.feed('data: hello\n\n');
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe('hello');
  });

  it('reassembles an event split across arbitrary byte boundaries', () => {
    const parser = new SseParser();
    const raw = 'event: message\ndata: {"a":1}\n\n';
    const events = [];
    // Feed one byte at a time: the worst case for a streaming client.
    for (const byte of Buffer.from(raw, 'utf8')) {
      events.push(...parser.feed(Buffer.from([byte])));
    }
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe('message');
    expect(events[0]?.data).toBe('{"a":1}');
  });

  it('joins multi-line data fields with newlines per the SSE spec', () => {
    const parser = new SseParser();
    const events = parser.feed('data: line one\ndata: line two\n\n');
    expect(events[0]?.data).toBe('line one\nline two');
  });

  it('handles CRLF line endings', () => {
    const parser = new SseParser();
    const events = parser.feed('data: crlf\r\n\r\n');
    expect(events[0]?.data).toBe('crlf');
  });

  it('ignores comment/heartbeat lines', () => {
    const parser = new SseParser();
    const events = parser.feed(': keep-alive\n\ndata: real\n\n');
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe('real');
  });

  it('parses several events in one chunk', () => {
    const parser = new SseParser();
    const events = parser.feed('data: one\n\ndata: two\n\ndata: three\n\n');
    expect(events.map((event) => event.data)).toEqual(['one', 'two', 'three']);
  });

  it('flushes a trailing event without a terminating blank line', () => {
    const parser = new SseParser();
    expect(parser.feed('data: dangling')).toHaveLength(0);
    const flushed = parser.flush();
    expect(flushed).toHaveLength(1);
    expect(flushed[0]?.data).toBe('dangling');
  });

  it('splits a multi-byte UTF-8 character across chunks without corruption', () => {
    const parser = new SseParser();
    const payload = 'data: 你好世界\n\n';
    const buffer = Buffer.from(payload, 'utf8');
    // Cut in the middle of a 3-byte character.
    const events = [...parser.feed(buffer.subarray(0, 8)), ...parser.feed(buffer.subarray(8))];
    expect(events[0]?.data).toBe('你好世界');
  });

  it('treats a chunk value as raw bytes, not as UTF-16 text', () => {
    const parser = new SseParser();
    const events = parser.feed(new Uint8Array([0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0x78, 0x0a, 0x0a]));
    expect(events[0]?.data).toBe('x');
  });
});

describe('parseSseJson', () => {
  it('recognises the [DONE] sentinel', () => {
    expect(parseSseJson({ data: '[DONE]' }).kind).toBe('done');
  });

  it('parses JSON payloads', () => {
    const result = parseSseJson({ data: '{"type":"x"}' });
    expect(result.kind).toBe('json');
    if (result.kind === 'json') expect(result.value).toEqual({ type: 'x' });
  });

  it('reports invalid JSON instead of throwing', () => {
    expect(parseSseJson({ data: '{not json' }).kind).toBe('invalid');
  });

  it('tolerates a missing data field', () => {
    // An empty payload carries nothing to parse; it is treated as the
    // end-of-stream sentinel rather than as malformed JSON.
    expect(parseSseJson({ event: 'ping', data: '' }).kind).toBe('done');
  });
});

describe('frame encoding', () => {
  it('emits an event name and data line', () => {
    const frame = encodeSseFrame({ event: 'message', data: '{"a":1}' });
    expect(frame).toBe('event: message\ndata: {"a":1}\n\n');
  });

  it('splits multi-line data into multiple data fields', () => {
    const frame = encodeSseFrame({ data: 'a\nb' });
    expect(frame).toBe('data: a\ndata: b\n\n');
  });

  it('encodes JSON with an event name', () => {
    expect(encodeSseJson('thing', { type: 'x' })).toBe('event: thing\ndata: {"type":"x"}\n\n');
  });
});

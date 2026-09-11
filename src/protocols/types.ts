import type { CanonicalRequest, CanonicalResponse } from '../canonical/protocol.js';
import type { CanonicalStreamEvent } from '../canonical/stream.js';
import type { GatewayError } from '../errors/gateway-error.js';
import type { ProtocolId } from '../domain/types.js';

/**
 * Protocol adapter contract.
 *
 * Every external protocol implements both directions:
 *   wire → canonical (parseRequest / parseResponse / stream parser)
 *   canonical → wire (serializeRequest / serializeResponse / stream serializer)
 *
 * Adding a protocol therefore costs two conversions rather than N×N pairwise
 * converters. Stream handling is split so that upstream parsing and client
 * serialization are independent — the same canonical event stream feeds any
 * client protocol.
 */

export interface ProtocolContext {
  requestId: string;
  /** Model id the client asked for (echoed back in responses). */
  clientModel: string;
}

export interface ProtocolStreamParser {
  /** Feed a raw upstream chunk; returns zero or more canonical events. */
  push(chunk: Uint8Array | string): CanonicalStreamEvent[];
  /** Flush when the upstream stream ends. */
  end(): CanonicalStreamEvent[];
  /** True once a terminal event ([DONE] / message_stop) was observed. */
  readonly finished: boolean;
  /** Number of malformed upstream payloads skipped (observability). */
  readonly malformedCount: number;
}

export interface ProtocolStreamSerializer {
  /** Serialize one canonical event into zero or more client SSE frames. */
  serialize(event: CanonicalStreamEvent): string[];
  /** Frames written after the canonical stream finishes (e.g. `data: [DONE]`). */
  end(): string[];
  readonly contentType: string;
}

export interface ParsedHttpBody {
  status: number;
  body: unknown;
}

export interface ProtocolAdapter {
  readonly id: ProtocolId;
  /** Content type for client responses. */
  readonly contentType: string;

  /** Client wire request → canonical request. Throws GatewayError on bad input. */
  parseRequest(body: unknown, context: ProtocolContext): CanonicalRequest;

  /** Canonical request → upstream wire request body. */
  serializeRequest(request: CanonicalRequest): unknown;

  /** Upstream wire response (non-streaming) → canonical response. */
  parseResponse(body: unknown, context: ProtocolContext): CanonicalResponse;

  /** Canonical response → client wire response (non-streaming). */
  serializeResponse(response: CanonicalResponse, context: ProtocolContext): unknown;

  /** Create a parser for an upstream stream of this protocol. */
  createStreamParser(context: ProtocolContext): ProtocolStreamParser;

  /** Create a serializer producing client frames of this protocol. */
  createStreamSerializer(context: ProtocolContext): ProtocolStreamSerializer;

  /** Serialize a gateway error in this protocol's error envelope. */
  serializeError(error: GatewayError, context: ProtocolContext): ParsedHttpBody;
}

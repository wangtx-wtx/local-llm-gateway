import type { CanonicalRequest, CanonicalResponse } from '../../canonical/protocol.js';
import type { GatewayError } from '../../errors/gateway-error.js';
import type { ProtocolAdapter, ParsedHttpBody, ProtocolContext, ProtocolStreamParser, ProtocolStreamSerializer } from '../types.js';
import { buildAnthropicMessage, parseAnthropicMessage } from './mapping.js';
import { parseAnthropicRequest, serializeAnthropicRequest } from './request.js';
import { AnthropicStreamParser, AnthropicStreamSerializer } from './stream.js';

/** Map a gateway error onto an Anthropic error envelope + status. */
function anthropicErrorEnvelope(error: GatewayError): { status: number; type: string } {
  switch (error.kind) {
    case 'authentication_error':
      return { status: 401, type: 'authentication_error' };
    case 'rate_limit_error':
      return { status: 429, type: 'rate_limit_error' };
    case 'invalid_request_error':
    case 'context_length_error':
    case 'capability_not_supported_error':
      return { status: 400, type: 'invalid_request_error' };
    case 'model_not_found_error':
      return { status: 404, type: 'not_found_error' };
    case 'timeout_error':
      return { status: 504, type: 'timeout_error' };
    case 'provider_unavailable_error':
      return { status: 529, type: 'overloaded_error' };
    case 'no_available_api_key_error':
      return { status: 503, type: 'api_error' };
    case 'client_disconnected_error':
      return { status: 499, type: 'api_error' };
    case 'internal_gateway_error':
    case 'network_error':
    case 'stream_error':
    case 'queue_full_error':
    default:
      return { status: error.statusCode, type: 'api_error' };
  }
}

export const anthropicAdapter: ProtocolAdapter = {
  id: 'anthropic-messages',
  contentType: 'application/json',

  parseRequest(body: unknown, context: ProtocolContext): CanonicalRequest {
    return parseAnthropicRequest(body, context);
  },

  serializeRequest(request: CanonicalRequest): unknown {
    return serializeAnthropicRequest(request);
  },

  parseResponse(body: unknown, context: ProtocolContext): CanonicalResponse {
    return parseAnthropicMessage(body, context);
  },

  serializeResponse(response: CanonicalResponse, context: ProtocolContext): unknown {
    return buildAnthropicMessage(response, context);
  },

  createStreamParser(context: ProtocolContext): ProtocolStreamParser {
    return new AnthropicStreamParser(context);
  },

  createStreamSerializer(context: ProtocolContext): ProtocolStreamSerializer {
    return new AnthropicStreamSerializer(context);
  },

  serializeError(error: GatewayError, context: ProtocolContext): ParsedHttpBody {
    const { status, type } = anthropicErrorEnvelope(error);
    return {
      status,
      body: {
        type: 'error',
        error: {
          type,
          message: error.message,
          ...(error.providerStatus !== undefined ? { upstream_status: error.providerStatus } : {}),
        },
        request_id: context.requestId,
      },
    };
  },
};

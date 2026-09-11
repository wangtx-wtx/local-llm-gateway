import type { CanonicalRequest, CanonicalResponse } from '../../canonical/protocol.js';
import type { GatewayError } from '../../errors/gateway-error.js';
import type { ProtocolAdapter, ParsedHttpBody, ProtocolContext, ProtocolStreamParser, ProtocolStreamSerializer } from '../types.js';
import { buildChatCompletion, parseChatCompletion } from './mapping.js';
import { parseOpenAIChatRequest, serializeOpenAIChatRequest } from './request.js';
import { ChatStreamParser, ChatStreamSerializer } from './stream.js';

/** OpenAI Chat Completions protocol adapter (client-facing and upstream-facing). */
export const openaiChatAdapter: ProtocolAdapter = {
  id: 'openai-chat',
  contentType: 'application/json',

  parseRequest(body: unknown, context: ProtocolContext): CanonicalRequest {
    return parseOpenAIChatRequest(body, context);
  },

  serializeRequest(request: CanonicalRequest): unknown {
    return serializeOpenAIChatRequest(request);
  },

  parseResponse(body: unknown, context: ProtocolContext): CanonicalResponse {
    return parseChatCompletion(body, context);
  },

  serializeResponse(response: CanonicalResponse, context: ProtocolContext): unknown {
    return buildChatCompletion(response, context);
  },

  createStreamParser(context: ProtocolContext): ProtocolStreamParser {
    return new ChatStreamParser(context);
  },

  createStreamSerializer(context: ProtocolContext): ProtocolStreamSerializer {
    return new ChatStreamSerializer(context);
  },

  serializeError(error: GatewayError, context: ProtocolContext): ParsedHttpBody {
    return {
      status: error.statusCode,
      body: {
        error: {
          message: error.message,
          type: error.kind,
          code: error.providerCode ?? error.kind,
          param: null,
        },
        request_id: context.requestId,
        ...(error.providerStatus !== undefined ? { upstream_status: error.providerStatus } : {}),
      },
    };
  },
};

import type { CanonicalRequest, CanonicalResponse } from '../../canonical/protocol.js';
import type { GatewayError } from '../../errors/gateway-error.js';
import type { ProtocolAdapter, ParsedHttpBody, ProtocolContext, ProtocolStreamParser, ProtocolStreamSerializer } from '../types.js';
import { buildResponsesBody, parseResponsesBody } from './mapping.js';
import { parseResponsesRequest, serializeResponsesRequest } from './request.js';
import { ResponsesStreamParser, ResponsesStreamSerializer } from './stream.js';

export const openaiResponsesAdapter: ProtocolAdapter = {
  id: 'openai-responses',
  contentType: 'application/json',

  parseRequest(body: unknown, context: ProtocolContext): CanonicalRequest {
    return parseResponsesRequest(body, context);
  },

  serializeRequest(request: CanonicalRequest): unknown {
    return serializeResponsesRequest(request);
  },

  parseResponse(body: unknown, context: ProtocolContext): CanonicalResponse {
    return parseResponsesBody(body, context);
  },

  serializeResponse(response: CanonicalResponse, context: ProtocolContext): unknown {
    return buildResponsesBody(response, context);
  },

  createStreamParser(context: ProtocolContext): ProtocolStreamParser {
    return new ResponsesStreamParser(context);
  },

  createStreamSerializer(context: ProtocolContext): ProtocolStreamSerializer {
    return new ResponsesStreamSerializer(context);
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
      },
    };
  },
};

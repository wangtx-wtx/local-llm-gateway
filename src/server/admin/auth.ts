import type { IncomingHttpHeaders } from 'node:http';
import { safeEqual } from '../../infra/crypto.js';
import { isLoopbackAddress } from '../http-utils.js';
import { HttpError, extractCredential } from '../http-utils.js';
import type { RouteRequest } from '../router.js';

/**
 * Admin authentication.
 *
 * Fail-closed rules:
 *  - when LOCAL_GATEWAY_ADMIN_PASSWORD is set, it is always required;
 *  - when it is not set, admin access is allowed only from a loopback client
 *    address on a loopback bind — anything else is refused, so an accidentally
 *    exposed instance never serves an unauthenticated control plane.
 */
export interface AdminAuthOptions {
  adminPassword: string | null;
  bindIsLoopback: boolean;
}

export function assertAdmin(request: RouteRequest, options: AdminAuthOptions): void {
  const provided = extractCredential({ headers: request.headers, query: request.query }, ['x-admin-password']);

  if (options.adminPassword) {
    if (!provided || !safeEqual(provided, options.adminPassword)) {
      throw new HttpError(401, 'Admin authentication required', {
        error: { message: 'Invalid or missing admin password', type: 'authentication_error' },
      });
    }
    return;
  }

  const remote = request.req.socket.remoteAddress;
  if (!options.bindIsLoopback || !isLoopbackAddress(remote)) {
    throw new HttpError(403, 'Admin access is not configured', {
      error: {
        message:
          'No admin password is configured and the request did not originate from this host. ' +
          'Set LOCAL_GATEWAY_ADMIN_PASSWORD to enable remote administration.',
        type: 'permission_error',
      },
    });
  }
}

export function isAdminAuthorized(headers: IncomingHttpHeaders, adminPassword: string | null): boolean {
  if (!adminPassword) return true;
  const raw = headers['x-admin-password'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return false;
  return safeEqual(value, adminPassword);
}

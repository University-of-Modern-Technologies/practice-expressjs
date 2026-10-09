import { isIP } from 'node:net';
import type { Request } from 'express';

import { AppError } from '../../common/errors/app-error.js';
import type { Actor } from '../rbac/types.js';

/** Width of the `user_agent` column; a longer header is cut to fit. */
export const MAX_USER_AGENT_LENGTH = 512;

/** Where a request came from, as recorded on the session it opens or renews. */
export interface SessionClient {
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

const IPV4_MAPPED_PREFIX = '::ffff:';

/**
 * A peer address in the form the `inet` column stores, or `null`.
 *
 * Anything that is not an address is dropped rather than allowed to fail the
 * write. An IPv4 peer seen through a dual-stack socket is unwrapped, so both
 * servers record the same text for the same client.
 */
export const normalizeIpAddress = (value: string | undefined | null): string | null => {
  if (!value || isIP(value) === 0) return null;
  if (value.toLowerCase().startsWith(IPV4_MAPPED_PREFIX)) {
    const embedded = value.slice(IPV4_MAPPED_PREFIX.length);
    if (isIP(embedded) === 4) return embedded;
  }
  return value;
};

export const sessionClientOf = (
  ipAddress: string | undefined | null,
  userAgent: string | undefined | null,
): SessionClient => ({
  ipAddress: normalizeIpAddress(ipAddress),
  userAgent: userAgent ? userAgent.slice(0, MAX_USER_AGENT_LENGTH) : null,
});

/**
 * The caller's address and user agent. The address is the one Express resolved
 * for the connection, not a header the client is free to write.
 */
export const requestClient = (request: Request): SessionClient =>
  sessionClientOf(request.ip, request.get('user-agent'));

/** The caller of an administrative change, with the address it came from. */
export const requestActor = (request: Request): Actor => {
  if (!request.auth) throw new AppError('Unauthorized', 401, 'UNAUTHORIZED');
  return { actorId: request.auth.userId, ipAddress: requestClient(request).ipAddress };
};

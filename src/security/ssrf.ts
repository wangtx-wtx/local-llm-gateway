import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { GatewayError, gatewayErrors } from '../errors/gateway-error.js';

/**
 * SSRF protection for user-configured provider base URLs.
 *
 * Rules:
 *  - only http/https schemes are accepted
 *  - cloud metadata endpoints are always blocked
 *  - loopback / private / link-local / CGNAT targets require
 *    provider.allowPrivateNetwork === true
 *  - hostnames are resolved to concrete addresses up front and the connection
 *    is pinned to those addresses, which defeats DNS rebinding between the
 *    check and the TCP connect
 */

export type IpClass = 'public' | 'loopback' | 'private' | 'link_local' | 'metadata' | 'reserved';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

const METADATA_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'metadata',
]);

const METADATA_IPS = new Set([
  '169.254.169.254', // AWS / Azure / GCP / DigitalOcean
  '169.254.170.2', // AWS ECS task metadata
  '100.100.100.200', // Alibaba Cloud
  '192.0.0.192', // Oracle Cloud
  'fd00:ec2::254', // AWS IMDS over IPv6
  'fd00:ec2:0:0:0:0:0:254',
]);

function ipv4ToInt(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const octet = Number.parseInt(part, 10);
    if (!Number.isFinite(octet) || octet < 0 || octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function inCidr(value: number, base: string, bits: number): boolean {
  const baseValue = ipv4ToInt(base);
  if (baseValue === null) return false;
  const mask = bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0;
  return (value & mask) === (baseValue & mask);
}

function classifyIpv4(address: string): IpClass {
  if (METADATA_IPS.has(address)) return 'metadata';
  const value = ipv4ToInt(address);
  if (value === null) return 'reserved';
  if (inCidr(value, '127.0.0.0', 8)) return 'loopback';
  if (inCidr(value, '10.0.0.0', 8)) return 'private';
  if (inCidr(value, '172.16.0.0', 12)) return 'private';
  if (inCidr(value, '192.168.0.0', 16)) return 'private';
  if (inCidr(value, '100.64.0.0', 10)) return 'private'; // CGNAT
  if (inCidr(value, '169.254.0.0', 16)) return 'link_local';
  if (inCidr(value, '0.0.0.0', 8)) return 'reserved';
  if (inCidr(value, '192.0.0.0', 24)) return 'reserved';
  if (inCidr(value, '198.18.0.0', 15)) return 'reserved'; // benchmarking
  if (inCidr(value, '224.0.0.0', 4)) return 'reserved'; // multicast
  if (inCidr(value, '240.0.0.0', 4)) return 'reserved'; // future use / broadcast
  if (inCidr(value, '255.255.255.255', 32)) return 'reserved';
  return 'public';
}

function expandIpv6(address: string): string[] | null {
  // Strip zone id (fe80::1%eth0)
  const zoneIndex = address.indexOf('%');
  const clean = zoneIndex >= 0 ? address.slice(0, zoneIndex) : address;
  const lower = clean.toLowerCase();

  // IPv4-mapped / IPv4-compatible forms
  if (lower.includes('.')) {
    const lastColon = lower.lastIndexOf(':');
    const v4 = lower.slice(lastColon + 1);
    const prefix = lower.slice(0, lastColon + 1);
    const v4Parts = v4.split('.').map((p) => Number.parseInt(p, 10));
    if (v4Parts.length !== 4 || v4Parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return null;
    const high = ((v4Parts[0]! << 8) | v4Parts[1]!).toString(16);
    const low = ((v4Parts[2]! << 8) | v4Parts[3]!).toString(16);
    return expandIpv6(`${prefix}${high}:${low}`);
  }

  const halves = lower.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':').filter((s) => s.length > 0) : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':').filter((s) => s.length > 0) : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  if (halves.length === 1 && head.length !== 8) return null;
  const groups = [...head, ...Array<string>(missing).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  return groups.map((g) => g.padStart(4, '0'));
}

function classifyIpv6(address: string): IpClass {
  const normalized = address.toLowerCase();
  if (METADATA_IPS.has(normalized)) return 'metadata';
  const groups = expandIpv6(normalized);
  if (!groups) return 'reserved';
  const first = Number.parseInt(groups[0]!, 16);
  const allZero = groups.every((g) => g === '0000');
  if (allZero) return 'reserved';
  const isLoopback = groups.slice(0, 7).every((g) => g === '0000') && groups[7] === '0001';
  if (isLoopback) return 'loopback';

  // IPv4-mapped ::ffff:a.b.c.d
  const mapped = groups.slice(0, 5).every((g) => g === '0000') && groups[5] === 'ffff';
  if (mapped) {
    const v4 = `${Number.parseInt(groups[6]!.slice(0, 2), 16)}.${Number.parseInt(groups[6]!.slice(2), 16)}.${Number.parseInt(groups[7]!.slice(0, 2), 16)}.${Number.parseInt(groups[7]!.slice(2), 16)}`;
    return classifyIpv4(v4);
  }
  if ((first & 0xfe00) === 0xfc00) return 'private'; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return 'link_local'; // fe80::/10
  if ((first & 0xff00) === 0xff00) return 'reserved'; // multicast
  if ((first & 0xffc0) === 0xfec0) return 'reserved'; // site-local (deprecated)
  if (first === 0x2001 && Number.parseInt(groups[1]!, 16) === 0x0db8) return 'reserved'; // documentation
  return 'public';
}

export function classifyIp(address: string): IpClass {
  const family = isIP(address);
  if (family === 4) return classifyIpv4(address);
  if (family === 6) return classifyIpv6(address);
  return 'reserved';
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface ValidatedTarget {
  url: URL;
  hostname: string;
  port: number;
  tls: boolean;
  addresses: ResolvedAddress[];
  /** Classifications observed, for logging/auditing. */
  classes: IpClass[];
}

export interface UrlGuardOptions {
  allowPrivateNetwork: boolean;
  /** Injectable resolver (tests). */
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
}

export function isBlockedClass(cls: IpClass, allowPrivateNetwork: boolean): boolean {
  if (cls === 'metadata') return true;
  if (cls === 'public') return false;
  // loopback / private / link_local / reserved all require explicit opt-in
  return !allowPrivateNetwork;
}

/**
 * Validate a provider base URL and resolve it to pinned addresses.
 * Throws a GatewayError(invalid_request) when the target is not allowed.
 */
export async function validateUpstreamUrl(rawUrl: string, options: UrlGuardOptions): Promise<ValidatedTarget> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw gatewayErrors.invalidRequest(`Provider base URL is not a valid URL: ${rawUrl}`);
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new GatewayError('invalid_request_error', {
      message: `Unsupported URL scheme "${url.protocol}" — only http and https are allowed`,
      details: { url: rawUrl },
    });
  }
  if (url.username !== '' || url.password !== '') {
    throw gatewayErrors.invalidRequest('Provider base URL must not contain embedded credentials');
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname.length === 0) {
    throw gatewayErrors.invalidRequest('Provider base URL must include a hostname');
  }
  if (METADATA_HOSTNAMES.has(hostname)) {
    throw new GatewayError('invalid_request_error', {
      message: `Refusing to connect to cloud metadata endpoint "${hostname}"`,
      details: { hostname },
    });
  }

  const port = url.port !== '' ? Number.parseInt(url.port, 10) : url.protocol === 'https:' ? 443 : 80;
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw gatewayErrors.invalidRequest(`Invalid port in provider base URL: ${url.port}`);
  }

  const literalFamily = isIP(hostname);
  let addresses: ResolvedAddress[];
  if (literalFamily !== 0) {
    addresses = [{ address: hostname, family: literalFamily === 6 ? 6 : 4 }];
  } else {
    const resolver =
      options.resolve ??
      (async (host: string): Promise<ResolvedAddress[]> => {
        const records = await lookup(host, { all: true, verbatim: true });
        return records.map((record) => ({ address: record.address, family: record.family === 6 ? 6 : 4 }));
      });
    try {
      addresses = await resolver(hostname);
    } catch (err) {
      throw new GatewayError('network_error', {
        message: `DNS resolution failed for ${hostname}`,
        cause: err,
        details: { hostname },
      });
    }
  }

  if (addresses.length === 0) {
    throw new GatewayError('network_error', {
      message: `DNS resolution returned no addresses for ${hostname}`,
      details: { hostname },
    });
  }

  const classes = addresses.map((entry) => classifyIp(entry.address));
  const blocked = classes.filter((cls) => isBlockedClass(cls, options.allowPrivateNetwork));
  if (blocked.length === addresses.length) {
    throw new GatewayError('invalid_request_error', {
      message:
        `Refusing to connect to ${hostname} (${classes.join(', ')}). ` +
        'Enable "Allow private network" on the provider if this address is intentional.',
      details: { hostname, classes, addresses: addresses.map((a) => a.address), allowPrivateNetwork: options.allowPrivateNetwork },
    });
  }

  // Keep only the addresses that survived the policy check.
  const allowed = addresses.filter((entry) => !isBlockedClass(classifyIp(entry.address), options.allowPrivateNetwork));

  return {
    url,
    hostname,
    port,
    tls: url.protocol === 'https:',
    addresses: allowed,
    classes,
  };
}

/** Validate a base URL without doing DNS work (used by the admin API). */
export function validateUrlShape(rawUrl: string): { ok: true; url: URL } | { ok: false; message: string } {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, message: `"${rawUrl}" is not a valid URL` };
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return { ok: false, message: `Unsupported scheme "${url.protocol}"; use http or https` };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, message: 'URL must not contain embedded credentials' };
  }
  if (url.hostname === '') return { ok: false, message: 'URL must include a hostname' };
  // Reject metadata hostnames here too: this validator gates the dashboard's
  // "test connection" button, which must not be usable as an SSRF probe.
  if (METADATA_HOSTNAMES.has(url.hostname.replace(/^\[|\]$/g, '').toLowerCase())) {
    return { ok: false, message: `Refusing to connect to cloud metadata endpoint "${url.hostname}"` };
  }
  return { ok: true, url };
}

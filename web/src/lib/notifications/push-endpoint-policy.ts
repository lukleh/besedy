import {
  lookup as systemLookup,
  type LookupAddress,
  type LookupAllOptions,
} from 'node:dns';
import { Agent } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { returnResolvedAddresses } from '@/lib/network/resolved-lookup';

const IPV4_HOSTNAME_PATTERN = /^\d{1,3}(\.\d{1,3}){3}$/;

const NON_PUBLIC_IPV4 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  NON_PUBLIC_IPV4.addSubnet(network, prefix, 'ipv4');
}

const GLOBAL_IPV6 = new BlockList();
GLOBAL_IPV6.addSubnet('2000::', 3, 'ipv6');

const WELL_KNOWN_NAT64 = new BlockList();
WELL_KNOWN_NAT64.addSubnet('64:ff9b::', 96, 'ipv6');

const NON_PUBLIC_IPV6 = new BlockList();
for (const [network, prefix] of [
  ['2001::', 32],
  ['2001:2::', 48],
  ['2001:10::', 28],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3ffe::', 16],
  ['3fff::', 20],
] as const) {
  NON_PUBLIC_IPV6.addSubnet(network, prefix, 'ipv6');
}

function parseIpv6Words(address: string): number[] | null {
  let normalized = address.split('%', 1)[0];
  const ipv4Tail = normalized.match(
    /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/,
  );
  if (ipv4Tail) {
    const octets = ipv4Tail.slice(1).map(Number);
    const tailStart = normalized.lastIndexOf(':');
    normalized = `${normalized.slice(0, tailStart)}:${(
      (octets[0] << 8) |
      octets[1]
    ).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }

  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const words = [
    ...left,
    ...Array.from({ length: missing }, () => '0'),
    ...right,
  ].map((word) => Number.parseInt(word, 16));
  return words.length === 8 && words.every(Number.isFinite) ? words : null;
}

function getWellKnownNat64Ipv4(address: string): string | null {
  const words = parseIpv6Words(address);
  if (!words) return null;
  return [words[6] >> 8, words[6] & 0xff, words[7] >> 8, words[7] & 0xff].join(
    '.',
  );
}

function getIpv4MappedAddress(address: string): string | null {
  const words = parseIpv6Words(address);
  if (!words) return null;
  // IPv4-mapped: ::ffff:a.b.c.d → words[0..4] = 0, words[5] = 0xffff
  if (
    words[0] === 0 &&
    words[1] === 0 &&
    words[2] === 0 &&
    words[3] === 0 &&
    words[4] === 0 &&
    words[5] === 0xffff
  ) {
    return `${words[6] >> 8}.${words[6] & 0xff}.${words[7] >> 8}.${words[7] & 0xff}`;
  }
  return null;
}

export class UnsafePushEndpointError extends Error {
  readonly code = 'E_PUSH_ENDPOINT_BLOCKED';

  constructor(message: string) {
    super(message);
    this.name = 'UnsafePushEndpointError';
  }
}

export function isPlausiblePushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  if (url.port && url.port !== '443') return false;
  const hostname = url.hostname.replace(/\.$/, '');
  if (!hostname.includes('.')) return false;
  if (url.hostname.startsWith('[') || IPV4_HOSTNAME_PATTERN.test(hostname)) {
    return false;
  }
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.home.arpa')
  ) {
    return false;
  }
  return true;
}

export function isPublicPushAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return !NON_PUBLIC_IPV4.check(address, 'ipv4');
  }
  if (family === 6) {
    if (WELL_KNOWN_NAT64.check(address, 'ipv6')) {
      const embeddedIpv4 = getWellKnownNat64Ipv4(address);
      return embeddedIpv4 !== null && isPublicPushAddress(embeddedIpv4);
    }
    // Handle IPv4-mapped IPv6 addresses (::ffff:a.b.c.d) by delegating
    // to the IPv4 check, so public IPv4s aren't falsely rejected.
    const ipv4Mapped = getIpv4MappedAddress(address);
    if (ipv4Mapped !== null) {
      return isPublicPushAddress(ipv4Mapped);
    }
    return (
      GLOBAL_IPV6.check(address, 'ipv6') &&
      !NON_PUBLIC_IPV6.check(address, 'ipv6')
    );
  }
  return false;
}

export type LookupAllResolver = (
  hostname: string,
  options: LookupAllOptions,
  callback: (
    error: NodeJS.ErrnoException | null,
    addresses: LookupAddress[],
  ) => void,
) => void;

const resolveAll: LookupAllResolver = (hostname, options, callback) => {
  systemLookup(hostname, options, callback);
};

/**
 * Resolve and validate inside the HTTPS agent so the socket uses the exact
 * addresses that passed the public-address policy. This avoids a separate
 * preflight lookup that could be bypassed by DNS rebinding.
 */
export function createPublicPushAgent(
  resolver: LookupAllResolver = resolveAll,
): Agent {
  const lookup: LookupFunction = (hostname, options, callback) => {
    resolver(
      hostname,
      { ...options, all: true, verbatim: true },
      (error, addresses) => {
        if (error) {
          callback(error, '', 0);
          return;
        }
        if (addresses.length === 0) {
          callback(
            new UnsafePushEndpointError(
              `Push endpoint hostname did not resolve: ${hostname}`,
            ),
            '',
            0,
          );
          return;
        }
        const unsafe = addresses.find(
          (address) => !isPublicPushAddress(address.address),
        );
        if (unsafe) {
          callback(
            new UnsafePushEndpointError(
              `Push endpoint resolved to a non-public address: ${unsafe.address}`,
            ),
            '',
            0,
          );
          return;
        }

        returnResolvedAddresses(addresses, options, callback);
      },
    );
  };

  return new Agent({ keepAlive: false, lookup });
}

export function isUnsafePushEndpointError(error: unknown): boolean {
  return (
    error instanceof UnsafePushEndpointError ||
    (typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'E_PUSH_ENDPOINT_BLOCKED')
  );
}

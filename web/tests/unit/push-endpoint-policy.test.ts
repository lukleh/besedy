import { describe, expect, it, vi } from 'vitest';
import type { LookupFunction } from 'node:net';
import {
  createPublicPushAgent,
  isPlausiblePushEndpoint,
  isPublicPushAddress,
  type LookupAllResolver,
} from '@/lib/notifications/push-endpoint-policy';

function runAgentLookup(
  resolver: LookupAllResolver,
  hostname = 'push.example.com',
): Promise<{ address: string | object[]; family?: number }> {
  const agent = createPublicPushAgent(resolver);
  const lookup = agent.options.lookup as LookupFunction;
  return new Promise((resolve, reject) => {
    lookup(hostname, { all: false }, (error, address, family) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ address, family });
    });
  });
}

describe('push endpoint transport policy', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.5',
    '169.254.169.254',
    '192.168.1.2',
    '::1',
    'fc00::1',
    'fe80::1',
    '2001::1',
    '2001:db8::1',
    '2002:0808:0808::1',
    '3ffe::1',
    '3fff::1',
    '3fff:0fff:ffff::1',
    '5f00::1',
  ])('rejects non-public address %s', (address) => {
    expect(isPublicPushAddress(address)).toBe(false);
  });

  it.each(['8.8.8.8', '2606:4700:4700::1111'])(
    'accepts public address %s',
    (address) => {
      expect(isPublicPushAddress(address)).toBe(true);
    },
  );

  it('accepts standard NAT64 only when the embedded IPv4 address is public', () => {
    expect(isPublicPushAddress('64:ff9b::808:808')).toBe(true);
    expect(isPublicPushAddress('64:ff9b::8.8.8.8')).toBe(true);
    expect(isPublicPushAddress('64:ff9b::a00:1')).toBe(false);
    expect(isPublicPushAddress('64:ff9b::c000:201')).toBe(false);
  });

  it('blocks a syntactically plausible hostname when DNS resolves privately', async () => {
    expect(isPlausiblePushEndpoint('https://127.0.0.1.nip.io/push')).toBe(true);
    const resolver: LookupAllResolver = vi.fn((_hostname, _options, callback) =>
      callback(null, [{ address: '127.0.0.1', family: 4 }]),
    );

    await expect(
      runAgentLookup(resolver, '127.0.0.1.nip.io'),
    ).rejects.toMatchObject({ code: 'E_PUSH_ENDPOINT_BLOCKED' });
  });

  it('returns the exact public DNS result to the socket', async () => {
    const resolver: LookupAllResolver = vi.fn((_hostname, _options, callback) =>
      callback(null, [{ address: '8.8.8.8', family: 4 }]),
    );

    await expect(runAgentLookup(resolver)).resolves.toEqual({
      address: '8.8.8.8',
      family: 4,
    });
  });
});

import type { LookupAddress, LookupOptions } from 'node:dns';
import type { LookupFunction } from 'node:net';

type LookupCallback = Parameters<LookupFunction>[2];

/** Return a non-empty, prevalidated DNS result in the shape Node requested. */
export function returnResolvedAddresses(
  addresses: LookupAddress[],
  options: LookupOptions,
  callback: LookupCallback,
): void {
  if (options.all) {
    callback(null, addresses);
    return;
  }
  const first = addresses[0];
  callback(null, first.address, first.family);
}

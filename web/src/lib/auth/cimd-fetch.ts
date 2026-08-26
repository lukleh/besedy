import { isPublicRoutableHost } from '@better-auth/core/utils/host';
import type { ClientMetadataResourceFetch } from '@better-auth/oauth-provider';
import type {
  LookupAddress,
  LookupAllOptions,
  LookupOneOptions,
} from 'node:dns';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';

const BODY_FORBIDDEN_RESPONSE_STATUSES = new Set([204, 205, 304]);

function responseHeaders(headers: NodeJS.Dict<string | string[]>): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) result.append(name, item);
    } else if (value !== undefined) {
      result.append(name, value);
    }
  }
  return result;
}

export function pinnedLookupResult(
  address: LookupAddress,
  options: LookupAllOptions | LookupOneOptions | number,
): LookupAddress | LookupAddress[] {
  return typeof options === 'object' && options.all ? [address] : address;
}

/**
 * Node 24-compatible variant of @better-auth/cimd/node's secure transport.
 *
 * Better Auth 1.7.1 always invokes the lookup callback in single-address form.
 * Node 24 requests `all: true` while auto-selecting an address and therefore
 * requires an array. Keep the SDK's resolve-once DNS validation, connection
 * pinning, TLS hostname, and no-redirect behavior while returning the callback
 * shape requested by Node.
 */
export const fetchCimdClientMetadataResource: ClientMetadataResourceFetch =
  async (input, init) => {
    const webRequest = new Request(input, init);
    const url = new URL(webRequest.url);
    if (url.protocol !== 'https:') {
      throw new TypeError('CIMD Node transport requires an HTTPS URL');
    }
    if (webRequest.method !== 'GET' && webRequest.method !== 'HEAD') {
      throw new TypeError('CIMD Node transport supports only GET and HEAD');
    }

    const addresses = await lookup(url.hostname, {
      all: true,
      verbatim: true,
    });
    if (addresses.length === 0) {
      throw new TypeError('metadata hostname returned no DNS addresses');
    }
    for (const result of addresses) {
      if (!isPublicRoutableHost(result.address)) {
        throw new TypeError(
          'metadata hostname must resolve only to public-routable addresses',
        );
      }
    }

    const pinnedAddress = addresses[0];
    const headers = Object.fromEntries(webRequest.headers.entries());
    headers.host = url.host;
    const signal =
      init?.signal ??
      (input instanceof Request ? input.signal : webRequest.signal);

    return new Promise<Response>((resolve, reject) => {
      const metadataRequest = request(
        url,
        {
          agent: false,
          headers,
          method: webRequest.method,
          servername:
            isIP(url.hostname.replace(/^\[|\]$/g, '')) === 0
              ? url.hostname
              : undefined,
          signal,
          lookup: (_hostname, options, callback) => {
            const result = pinnedLookupResult(pinnedAddress, options);
            if (Array.isArray(result)) {
              callback(null, result);
            } else {
              callback(null, result.address, result.family);
            }
          },
        },
        (response) => {
          const status = response.statusCode ?? 500;
          const body =
            webRequest.method === 'HEAD' ||
            BODY_FORBIDDEN_RESPONSE_STATUSES.has(status)
              ? null
              : Readable.toWeb(response);
          resolve(
            new Response(body as BodyInit | null, {
              headers: responseHeaders(response.headers),
              status,
              statusText: response.statusMessage,
            }),
          );
        },
      );
      metadataRequest.once('error', reject);
      metadataRequest.end();
    });
  };

import { isPublicRoutableHost } from '@better-auth/core/utils/host';
import type { ClientMetadataResourceFetch } from '@better-auth/oauth-provider';
import type { LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { returnResolvedAddresses } from '@/lib/network/resolved-lookup';

const JSON_CONTENT_TYPE_RE = /^application\/(?:[-\w.]+\+)?json\s*(?:;|$)/i;

// Keep this explicit so a Better Auth upgrade must revisit the local transport
// instead of silently retaining a fork of an older SDK implementation.
export const CIMD_TRANSPORT_SDK_VERSION = '1.7.1';

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

function abortReason(signal: AbortSignal): unknown {
  return (
    signal.reason ??
    new DOMException('CIMD metadata DNS lookup aborted', 'AbortError')
  );
}

async function lookupWithSignal(
  hostname: string,
  signal: AbortSignal,
): Promise<LookupAddress[]> {
  signal.throwIfAborted();

  let rejectOnAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', rejectOnAbort, { once: true });
    if (signal.aborted) rejectOnAbort();
  });

  try {
    return await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      aborted,
    ]);
  } finally {
    if (rejectOnAbort) signal.removeEventListener('abort', rejectOnAbort);
  }
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

    const signal = webRequest.signal;
    const addresses = await lookupWithSignal(url.hostname, signal);
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

    const headers = Object.fromEntries(webRequest.headers.entries());
    headers.host = url.host;

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
            returnResolvedAddresses(addresses, options, callback);
          },
        },
        (response) => {
          try {
            const status = response.statusCode ?? 500;
            if (status < 200 || status > 599) {
              response.destroy();
              reject(
                new TypeError(
                  `metadata server returned invalid HTTP status ${status}`,
                ),
              );
              return;
            }

            const responseHeaderValues = responseHeaders(response.headers);
            const contentType = responseHeaderValues.get('content-type') ?? '';
            const hasMetadataBody =
              webRequest.method !== 'HEAD' &&
              status === 200 &&
              JSON_CONTENT_TYPE_RE.test(contentType);
            const body = hasMetadataBody ? Readable.toWeb(response) : null;
            if (!hasMetadataBody) response.destroy();

            resolve(
              new Response(body as BodyInit | null, {
                headers: responseHeaderValues,
                status,
                statusText: response.statusMessage,
              }),
            );
          } catch (error) {
            response.destroy();
            reject(error);
          }
        },
      );
      metadataRequest.once('error', reject);
      metadataRequest.end();
    });
  };

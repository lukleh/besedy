import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import type { LookupAddress } from 'node:dns';
import type { LookupFunction } from 'node:net';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import packageJson from '../../package.json';

const mocks = vi.hoisted(() => ({
  lookup: vi.fn(),
  request: vi.fn(),
}));

vi.mock('node:dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns/promises')>();
  const defaultExport = (actual as typeof actual & { default: typeof actual })
    .default;
  return {
    ...actual,
    default: { ...defaultExport, lookup: mocks.lookup },
    lookup: mocks.lookup,
  };
});

vi.mock('node:https', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:https')>();
  const defaultExport = (actual as typeof actual & { default: typeof actual })
    .default;
  return {
    ...actual,
    default: { ...defaultExport, request: mocks.request },
    request: mocks.request,
  };
});

import {
  CIMD_TRANSPORT_SDK_VERSION,
  fetchCimdClientMetadataResource,
} from '@/lib/auth/cimd-fetch';

const validatedAddresses: LookupAddress[] = [
  { address: '2606:4700:4700::1111', family: 6 },
  { address: '1.1.1.1', family: 4 },
];

let capturedRequestOptions: RequestOptions | undefined;

function arrangeHttpsResponse({
  body = '{"client_id":"https://metadata.example/client.json"}',
  contentType = 'application/json',
  status = 200,
}: {
  body?: string;
  contentType?: string;
  status?: number;
} = {}) {
  const response = Readable.from([
    Buffer.from(body),
  ]) as unknown as IncomingMessage;
  response.statusCode = status;
  response.statusMessage = 'Test response';
  response.headers = { 'content-type': contentType };
  const destroy = vi.spyOn(response, 'destroy');

  mocks.request.mockImplementation(
    (
      _url: unknown,
      options: RequestOptions,
      onResponse: (incoming: IncomingMessage) => void,
    ) => {
      capturedRequestOptions = options;
      const clientRequest = {} as ClientRequest;
      Object.assign(clientRequest, {
        once: vi.fn(() => clientRequest),
        end: vi.fn(() => onResponse(response)),
      });
      return clientRequest;
    },
  );

  return { destroy };
}

describe('CIMD metadata transport', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    capturedRequestOptions = undefined;
    mocks.lookup.mockResolvedValue(validatedAddresses);
  });

  it('keeps the local transport tied to the installed Better Auth version', () => {
    expect({
      cimd: packageJson.dependencies['@better-auth/cimd'],
      core: packageJson.dependencies['@better-auth/core'],
      oauthProvider: packageJson.dependencies['@better-auth/oauth-provider'],
      betterAuth: packageJson.dependencies['better-auth'],
    }).toEqual({
      cimd: CIMD_TRANSPORT_SDK_VERSION,
      core: CIMD_TRANSPORT_SDK_VERSION,
      oauthProvider: CIMD_TRANSPORT_SDK_VERSION,
      betterAuth: CIMD_TRANSPORT_SDK_VERSION,
    });
  });

  it('returns every validated address when Node requests all lookup results', async () => {
    arrangeHttpsResponse();

    const response = await fetchCimdClientMetadataResource(
      'https://metadata.example/client.json',
    );
    await expect(response.json()).resolves.toMatchObject({
      client_id: 'https://metadata.example/client.json',
    });

    const installedLookup = capturedRequestOptions?.lookup as LookupFunction;
    let returnedAddresses: LookupAddress[] | undefined;
    installedLookup('metadata.example', { all: true }, (error, addresses) => {
      expect(error).toBeNull();
      if (Array.isArray(addresses)) returnedAddresses = addresses;
    });

    expect(returnedAddresses).toEqual(validatedAddresses);
  });

  it('returns one validated address for a single-result lookup', async () => {
    arrangeHttpsResponse();
    await fetchCimdClientMetadataResource(
      'https://metadata.example/client.json',
    );

    const installedLookup = capturedRequestOptions?.lookup as LookupFunction;
    let returnedAddress: string | undefined;
    let returnedFamily: number | undefined;
    installedLookup(
      'metadata.example',
      { all: false },
      (error, address, family) => {
        expect(error).toBeNull();
        if (typeof address === 'string') returnedAddress = address;
        returnedFamily = family;
      },
    );

    expect(returnedAddress).toBe(validatedAddresses[0].address);
    expect(returnedFamily).toBe(validatedAddresses[0].family);
  });

  it('rejects an out-of-range HTTP status without throwing from the callback', async () => {
    const { destroy } = arrangeHttpsResponse({ status: 999 });

    await expect(
      fetchCimdClientMetadataResource('https://metadata.example/client.json'),
    ).rejects.toThrow('invalid HTTP status 999');
    expect(destroy).toHaveBeenCalledOnce();
  });

  it.each([
    { contentType: 'text/plain', status: 200 },
    { contentType: 'application/json', status: 403 },
  ])(
    'destroys a response body the CIMD caller will not consume: %o',
    async ({ contentType, status }) => {
      const { destroy } = arrangeHttpsResponse({ contentType, status });

      const response = await fetchCimdClientMetadataResource(
        'https://metadata.example/client.json',
      );

      expect(response.status).toBe(status);
      expect(response.body).toBeNull();
      expect(destroy).toHaveBeenCalledOnce();
    },
  );

  it('rejects promptly when the caller aborts during DNS resolution', async () => {
    mocks.lookup.mockReturnValue(new Promise(() => {}));
    const controller = new AbortController();

    const pending = fetchCimdClientMetadataResource(
      'https://metadata.example/client.json',
      { signal: controller.signal },
    );
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('rejects metadata hosts with any non-public DNS result', async () => {
    mocks.lookup.mockResolvedValue([
      validatedAddresses[0],
      { address: '127.0.0.1', family: 4 },
    ]);

    await expect(
      fetchCimdClientMetadataResource('https://metadata.example/client.json'),
    ).rejects.toThrow('must resolve only to public-routable addresses');
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it.each([
    ['an HTTP URL', 'http://metadata.example/client.json', undefined],
    [
      'a non-read method',
      'https://metadata.example/client.json',
      { method: 'POST' },
    ],
  ])('rejects %s before DNS resolution', async (_case, input, init) => {
    await expect(
      fetchCimdClientMetadataResource(input, init),
    ).rejects.toThrow();
    expect(mocks.lookup).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });
});

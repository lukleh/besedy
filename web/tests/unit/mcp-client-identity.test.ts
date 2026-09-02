import { describe, expect, it } from 'vitest';
import { getMcpClientMetadataOrigin } from '@/app/auth/mcp-client-identity';

describe('MCP client identity provenance', () => {
  it('identifies only credential-free HTTPS metadata origins', () => {
    expect(
      getMcpClientMetadataOrigin('https://client.example/mcp/client.json'),
    ).toBe('https://client.example');
    expect(getMcpClientMetadataOrigin('opaque-dcr-client-id')).toBeNull();
    expect(
      getMcpClientMetadataOrigin('http://client.example/client.json'),
    ).toBeNull();
    expect(
      getMcpClientMetadataOrigin(
        'https://user:pass@client.example/client.json',
      ),
    ).toBeNull();
  });
});

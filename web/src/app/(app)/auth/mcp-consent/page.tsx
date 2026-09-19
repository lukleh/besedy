import McpConsent from './mcp-consent';
import { notFound } from 'next/navigation';
import { isMcpEnabled } from '@/lib/mcp/config';

export default function McpConsentPage() {
  if (!isMcpEnabled()) notFound();
  return <McpConsent />;
}

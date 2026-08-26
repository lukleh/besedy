import McpSignIn from './mcp-signin';
import { notFound } from 'next/navigation';
import { isMcpEnabled } from '@/lib/mcp/config';

export default function McpSignInPage() {
  if (!isMcpEnabled()) notFound();

  const appEnv = process.env.APP_ENV;
  const hasMockOAuth =
    Boolean(process.env.OAUTH_MOCK_URL?.trim()) &&
    (appEnv === 'development' || appEnv === 'test');

  return <McpSignIn hasMockOAuth={hasMockOAuth} />;
}

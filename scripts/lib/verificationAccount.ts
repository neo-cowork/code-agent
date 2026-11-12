import os from 'node:os';
import path from 'node:path';
// @ts-expect-error — existing JS verification credential reader has no declaration
import { readDogfoodCredentials } from '../verify-slotless.mjs';

type Credentials = { email: string; password: string };
type AuthReply = { success?: boolean; data?: { success?: boolean; isAuthenticated?: boolean; sessionTrustState?: string; hasCachedAdminClaim?: boolean; user?: { email?: string; isAdmin?: boolean } } };

/** Resolve the token/log directory of an already running Dev app; never start it. */
export function resolveDevVerificationDataDir(url: string, dataDir?: string): string {
  if (dataDir) return path.resolve(dataDir);
  const slot = Number(new URL(url).port) - 8180;
  if (!Number.isInteger(slot) || slot < 1 || slot > 9) {
    throw new Error('verification on a non-Dev port requires an explicit data directory');
  }
  return path.join(os.homedir(), slot === 1 ? '.code-agent-dev' : `.code-agent-dev${slot}`);
}

async function invokeAuth(url: string, token: string | null, action: string, payload: unknown): Promise<AuthReply> {
  const endpoint = new URL(url);
  if (!['http:', 'https:'].includes(endpoint.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)) {
    throw new Error('verification auth requires a loopback server');
  }
  if (!token) throw new Error('verification server token is missing');
  const response = await fetch(new URL(`/api/domain/auth/${action}`, endpoint), {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload }), signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`verification auth ${action} failed: HTTP ${response.status}`);
  const body = await response.json() as AuthReply;
  if (!body.success) throw new Error(`verification auth ${action} failed`);
  return body;
}

/** Read-only admission: never replace, copy or refresh the resident user's session. */
export async function assertDogfoodVerificationAccount(url: string, token: string | null): Promise<void> {
  const { email } = readDogfoodCredentials() as Credentials;
  const { data } = await invokeAuth(url, token, 'getStatus', {});
  if (!data?.isAuthenticated || data.sessionTrustState !== 'verified' || data.hasCachedAdminClaim
    || data.user?.email !== email || data.user.isAdmin === true) {
    throw new Error('verification requires a verified non-admin dogfood account; resident login was not changed');
  }
}

/** Fresh isolated hosts must authenticate the actual uploader, not a dev-API UI stub. */
export async function signInDogfoodVerificationAccount(url: string, token: string): Promise<void> {
  const credentials = readDogfoodCredentials() as Credentials;
  const { data } = await invokeAuth(url, token, 'signInEmail', { email: credentials.email, password: credentials.password });
  if (!data?.success || data.user?.email !== credentials.email || data.user.isAdmin === true) {
    throw new Error('dogfood account sign-in was rejected');
  }
}

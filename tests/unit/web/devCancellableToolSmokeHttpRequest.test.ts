import express from 'express';
import { promises as fs } from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isPrivateOrLocalHost } from '../../../src/host/security/ssrfGuard';
import { createDevCancellableToolSmokeRouter } from '../../../src/web/routes/devCancellableToolSmoke';

interface CancellableState {
  id: string;
  url: string;
  requestStarted: string | null;
  requestClosed: string | null;
  cancelToSettledMs: number | null;
  result?: { error?: string };
}

let server: http.Server | undefined;
let baseUrl = '';
let runId: string | undefined;
let dataDir = '';

async function startApi(): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/dev/cancellable-tool', createDevCancellableToolSmokeRouter({
    isEnabled: () => true,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }));
  server = await new Promise<http.Server>((resolve) => {
    const next = app.listen(0, '127.0.0.1', () => resolve(next));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  baseUrl = `http://127.0.0.1:${address.port}/api/dev/cancellable-tool`;
}

afterEach(async () => {
  if (runId && baseUrl) {
    await fetch(`${baseUrl}/${runId}`, { method: 'DELETE' }).catch(() => undefined);
  }
  runId = undefined;
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => error ? reject(error) : resolve());
    });
    server = undefined;
  }
  baseUrl = '';
  vi.unstubAllEnvs();
  if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
  dataDir = '';
});

describe('dev cancellable http_request smoke', () => {
  it('passes the SSRF guard, reaches the delay server, and cancels through the real router', async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-cancellable-http-test-'));
    vi.stubEnv('CODE_AGENT_E2E', '1');
    vi.stubEnv('CODE_AGENT_DATA_DIR', dataDir);
    await startApi();

    const startResponse = await fetch(`${baseUrl}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool: 'http_request',
        sessionId: 'dev-cancellable-http-test',
        workingDirectory: process.cwd(),
        approvalPolicy: 'e2e-scripted-allow',
      }),
    });
    const started = await startResponse.json() as CancellableState;
    expect(startResponse.status, JSON.stringify(started)).toBe(200);
    runId = started.id;
    expect(isPrivateOrLocalHost(new URL(started.url).hostname)).toBe(false);
    expect(started.requestStarted).toBeTruthy();

    const cancelResponse = await fetch(`${baseUrl}/${runId}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const cancelled = await cancelResponse.json() as CancellableState;
    expect(cancelResponse.status, JSON.stringify(cancelled)).toBe(200);
    expect(cancelled.requestClosed).toBe('client_closed');
    expect(cancelled.result?.error).toBe('aborted');
    expect(cancelled.cancelToSettledMs).not.toBeNull();
    expect(cancelled.cancelToSettledMs!).toBeLessThanOrEqual(1_000);

    const cleanupResponse = await fetch(`${baseUrl}/${runId}`, { method: 'DELETE' });
    expect(cleanupResponse.status).toBe(200);
    runId = undefined;
  }, 60_000);
});

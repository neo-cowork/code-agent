import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, type CreateAppDeps } from '../../../src/web/app';
import { RunRegistry } from '../../../src/host/runtime/runRegistry';
import { SERVER_AUTH_TOKEN } from '../../../src/web/middleware/auth';
import { MAX_FOLDER_BATCH_BODY_SIZE } from '../../../src/shared/constants/chatUploads';
import { MAX_UPLOAD_SIZE } from '../../../src/web/helpers/upload';

let server: http.Server;
let baseUrl: string;
const roots: string[] = [];
let clock = Date.now();

beforeEach(async () => {
  clock += 60_001;
  vi.spyOn(Date, 'now').mockReturnValue(clock);
  const deps: CreateAppDeps = {
    handlers: new Map(), logger: { info() {}, warn() {}, error() {} },
    runRegistry: new RunRegistry(), pendingLocalToolCalls: new Map(), pendingDevPermissions: new Map(),
    resolveCodeAgentDataDir: () => path.join(os.tmpdir(), 'batch-upload-test'),
    getAppVersion: () => '0.0.0-test', getBuildInfo: () => null,
    getDurableRunRollout: () => ({
      policy: { mode: 'legacy', configuredValue: null, valid: true, durableActivation: false, durableReadPreference: false },
      ready: false,
    }),
    getDurableRunReadService: () => undefined,
    internalFeatures: {
      runtime: { isLoaded: () => false, loadedHash: () => undefined },
      registry: { getPlugin: () => undefined }, pluginsDir: path.join(os.tmpdir(), 'batch-upload-test', 'plugins'),
    },
  };
  server = http.createServer(createApp(deps));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
  vi.restoreAllMocks();
});

function batch(paths: string[], content = 'contract body') {
  const body = new FormData();
  paths.forEach((relativePath, index) => {
    body.append(`file${index}`, new Blob([content]), path.basename(relativePath));
    body.append(`relativePath${index}`, relativePath);
  });
  return body;
}
async function post(route: string, body: FormData) {
  return fetch(baseUrl + route, { method: 'POST', headers: { Authorization: `Bearer ${SERVER_AUTH_TOKEN}` }, body });
}
async function remember(response: Response) {
  const result = await response.json();
  if (result.root) roots.push(result.root);
  if (result.path) roots.push(path.dirname(result.path));
  return result;
}

describe('POST /api/upload/temp/batch through the Express app', () => {
  it('30 files including nested relativePath return 30 existing byte-exact paths under one root', async () => {
    const paths = Array.from({ length: 30 }, (_, n) => `contracts/${n % 2 ? 'nested/' : ''}contract-${n}.pdf`);
    const response = await post('/api/upload/temp/batch', batch(paths));
    expect(response.status).toBe(200);
    const result = await remember(response);
    expect(result.files).toHaveLength(30);
    for (const [index, file] of result.files.entries()) {
      expect(file.relativePath).toBe(paths[index]);
      expect(file.path).toBe(path.join(result.root, paths[index]));
      expect(fs.readFileSync(file.path, 'utf8')).toBe('contract body');
    }
    process.stdout.write('POST /api/upload/temp/batch 200: 30/30 existing paths; nested paths preserved; one root\n');
  });

  it.each(['../escape.pdf', 'contracts/../escape.pdf', 'contracts\\..\\escape.pdf', '/absolute.pdf', 'C:\\escape.pdf'])('rejects unsafe relativePath %s before any write', async (relativePath) => {
    const response = await post('/api/upload/temp/batch', batch(['valid.pdf', relativePath]));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid upload path' });
  });

  it('rejects sanitized path collisions rather than overwriting files', async () => {
    const response = await post('/api/upload/temp/batch', batch(['a b.pdf', 'a_b.pdf']));
    expect(response.status).toBe(400);
  });

  it('returns 413 with limit wording for a body exceeding 200MB', async () => {
    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = http.request(baseUrl + '/api/upload/temp/batch', {
        method: 'POST', headers: {
          Authorization: `Bearer ${SERVER_AUTH_TOKEN}`,
          'Content-Type': 'multipart/form-data; boundary=cap', 'Content-Length': MAX_FOLDER_BATCH_BODY_SIZE + 1,
        },
      }, (response) => {
        let body = '';
        response.on('data', (part) => { body += part; });
        response.on('end', () => resolve({ status: response.statusCode!, body }));
      });
      request.on('error', reject);
      request.end();
    });
    expect(result.status).toBe(413);
    expect(result.body).toContain('200MB limit');
    process.stdout.write(`over-total-cap: ${result.status} ${result.body}\n`);
  });

  it('enforces the 50MB per-file limit separately from the total', async () => {
    const body = new FormData();
    body.append('file0', new Blob([new Uint8Array(MAX_UPLOAD_SIZE + 1)]), 'large.pdf');
    body.append('relativePath0', 'large.pdf');
    const response = await post('/api/upload/temp/batch', body);
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'File exceeds 50MB limit' });
  });

  it('one batch leaves all 20 single uploads available; independent batch bucket allows 6, then 429', async () => {
    const statuses: number[] = [];
    const first = await post('/api/upload/temp/batch', batch(['contract.pdf']));
    expect(first.status).toBe(200);
    await remember(first);
    for (let n = 0; n < 21; n++) {
      const body = new FormData();
      body.append('file', new Blob(['contract']), 'contract.pdf');
      const response = await post('/api/upload/temp', body);
      statuses.push(response.status);
      await remember(response);
    }
    expect(statuses).toEqual([...Array(20).fill(200), 429]);
    const batchStatuses = [first.status];
    for (let n = 0; n < 6; n++) {
      const response = await post('/api/upload/temp/batch', batch(['contract.pdf']));
      batchStatuses.push(response.status);
      await remember(response);
    }
    expect(batchStatuses).toEqual([...Array(6).fill(200), 429]);
    process.stdout.write(`after batch 200, singles=${JSON.stringify(statuses)}; batch=${JSON.stringify(batchStatuses)}\n`);
  });
});

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import express from 'express';
import type { Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import PDFDocument from 'pdfkit';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerSettingsHandlers } from '../../../src/host/ipc/settings.ipc';
import { createExtractRouter } from '../../../src/web/routes/extract';
import type { WebRouteHandler } from '../../../src/web/routes/routeTypes';
import { buildMultimodalContent } from '../../../src/host/agent/messageHandling/converter';
import { AttachmentBar } from '../../../src/renderer/components/features/chat/ChatInput/AttachmentBar';
import type { MessageAttachment } from '../../../src/shared/contract';

const mocks = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const { promisify } = await import('node:util');
  return { ...actual, execFile: Object.assign(vi.fn(), { [promisify.custom]: mocks.exec }) };
});
vi.mock('../../../src/renderer/hooks/useI18n', async () => {
  const { zh } = await import('../../../src/renderer/i18n/zh');
  return { useI18n: () => ({ t: zh }) };
});

const binary = '/opt/homebrew/bin/pdftotext';
// Captured byte-for-byte from real pdftotext on the PDFKit contracts below.
const captured = [
  'Contract page 1\n\n\f',
  'Contract page 1\n\n\fContract page 2\n\n\f',
  'Contract page 1\n\n\fContract page 2\n\n\fContract page 3\n\n\f',
];
const handlers = new Map<string, WebRouteHandler>();
const dir = mkdtempSync(join(tmpdir(), 'pdf-pagecount-'));
const pdfs = [1, 2, 3].map(n => join(dir, `contract-${n}.pdf`));
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  for (const [index, filePath] of pdfs.entries()) {
    const doc = new PDFDocument();
    const stream = createWriteStream(filePath);
    doc.pipe(stream);
    for (let page = 1; page <= index + 1; page++) {
      if (page > 1) doc.addPage();
      doc.text(`Contract page ${page}`);
    }
    doc.end();
    await new Promise<void>((resolve, reject) => {
      stream.on('finish', resolve);
      stream.on('error', reject);
    });
  }
  registerSettingsHandlers({ handle: (name: string, handler: WebRouteHandler) => handlers.set(name, handler) } as never, () => null);
  const app = express();
  app.use(express.json());
  app.use('/api', createExtractRouter({ handlers }));
  server = await new Promise<Server>(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => { mocks.exec.mockReset(); });

async function extract(filePath: string): Promise<{ text: string; pageCount: number }> {
  const handler = handlers.get('extract-pdf-text');
  if (!handler) throw new Error('PDF handler not registered');
  return await handler(null, filePath) as { text: string; pageCount: number };
}

function assertConsumers(result: { text: string; pageCount: number }, pages: number) {
  const attachment: MessageAttachment = {
    id: 'contract', type: 'file', category: 'pdf', name: 'contract.pdf',
    size: 100, mimeType: 'application/pdf', data: result.text, pageCount: result.pageCount,
  };
  const card = renderToStaticMarkup(React.createElement(AttachmentBar, { attachments: [attachment], onRemove: () => {} }));
  expect(card).toContain(`${pages} 页`);
  const model = buildMultimodalContent('', [attachment]);
  expect(model).toContainEqual(expect.objectContaining({ type: 'text', text: expect.stringContaining(`(${pages} 页)`) }));
  if (pages === 1) {
    expect(card).not.toContain('2 页');
    expect(JSON.stringify(model)).not.toContain('(2 页)');
  }
}

describe('PDF attachment count through registered production handler', () => {
  it.each([1, 2, 3])('captured real pdftotext: %i-page contract agrees with card and model', async pages => {
    mocks.exec.mockResolvedValue({ stdout: captured[pages - 1] });
    const result = await extract(pdfs[pages - 1]);
    expect(result).toEqual({ text: captured[pages - 1], pageCount: pages });
    expect(mocks.exec).toHaveBeenCalledExactlyOnceWith(binary, [pdfs[pages - 1], '-'], { maxBuffer: 50 * 1024 * 1024 });
    assertConsumers(result, pages);
  });

  it.each([
    ['', 0], [' \n\t', 0], ['text', 1], ['\f', 1], ['\f\f', 2],
    ['text\f \n\t', 1], ['text\fnext page', 2],
  ])('counts boundary output %j as %i pages', async (text, pageCount) => {
    mocks.exec.mockResolvedValue({ stdout: text });
    await expect(extract(pdfs[0])).resolves.toEqual({ text, pageCount });
  });

  it.skipIf(!existsSync('/opt/homebrew/bin/pdftotext')).each([1, 2, 3])('real binary via handler and web route: %i pages', async pages => {
    const { execFile } = await vi.importActual<typeof import('child_process')>('child_process');
    const { promisify } = await import('node:util');
    mocks.exec.mockImplementation(promisify(execFile));
    const result = await extract(pdfs[pages - 1]);
    expect(result).toEqual({ text: captured[pages - 1], pageCount: pages });
    expect(execFileSync('/opt/homebrew/bin/pdfinfo', [pdfs[pages - 1]], { encoding: 'utf8' })).toMatch(new RegExp(`Pages:\\s+${pages}\\b`));
    assertConsumers(result, pages);
    const response = await fetch(`${baseUrl}/api/extract/pdf`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePath: pdfs[pages - 1] }),
    });
    expect(response.status).toBe(200);
    const raw = await response.text();
    console.log(`WEB PDF ${pages}: ${raw}`);
    expect(JSON.parse(raw)).toEqual(result);
    expect(mocks.exec).toHaveBeenCalledTimes(2);
    for (const call of mocks.exec.mock.calls) expect(call[0]).toBe(binary);
  });
});

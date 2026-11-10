// @vitest-environment jsdom
import React from 'react';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import type { Browser, Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadPlaywrightChromium } from '../../../src/host/agent/runtime/browser/playwrightRuntime';
import { ChannelsSettings, ChannelModal } from '../../../src/renderer/components/features/settings/tabs/ChannelsSettings';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';

const state = vi.hoisted(() => ({ reason: '' }));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: vi.fn(async (channel: string) => channel.toLowerCase().includes('types')
      ? [{ type: 'telegram', name: 'Telegram' }]
      : [{ id: 'layout-channel', name: 'Weekly report', type: 'telegram', status: 'error', errorMessage: state.reason, enabled: true, createdAt: 1, config: { type: 'telegram', botToken: '123:example' } }]),
    on: vi.fn(() => () => {}),
    invokeDomain: vi.fn(),
  },
}));
vi.mock('../../../src/renderer/components/features/settings/sections/CompanionSection', () => ({ CompanionSection: () => null }));

// IPC is a fixture; the markup comes from the public components and Chromium
// measures it using the production Tailwind stylesheet. This is not desktop E2E.
describe('channel text at narrow widths', () => {
  let vite: ViteDevServer;
  let browser: Browser;
  let page: Page;
  let origin: string;
  let cacheDir: string;

  beforeAll(async () => {
    cacheDir = mkdtempSync(path.join(os.tmpdir(), 'channel-text-layout-'));
    vite = await createServer({
      configFile: 'vite.config.ts',
      root: 'src/renderer',
      cacheDir,
      server: { host: '127.0.0.1', port: 0, strictPort: false },
      logLevel: 'error',
    });
    await vite.listen();
    origin = vite.resolvedUrls?.local[0] ?? '';
    if (!origin) throw new Error('Vite test origin unavailable');
    const runtime = await loadPlaywrightChromium();
    if (!runtime.ok || !runtime.chromium) throw new Error('Playwright Chromium unavailable');
    browser = await runtime.chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 360, height: 800 } });
  }, 30_000);

  afterEach(() => {
    cleanup();
    useAppStore.setState({ language: 'zh' });
  });
  afterAll(async () => {
    await browser?.close();
    await vite?.close();
    if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
  });

  async function layout(markup: string, width: number) {
    await page.setViewportSize({ width, height: 800 });
    await page.setContent(
      `<!doctype html><html><head><link rel="stylesheet" href="${origin}styles/global.css"></head>`
      + `<body style="margin:0">${markup}</body></html>`,
      { waitUntil: 'networkidle' },
    );
  }

  for (const [language, locale, reason] of [
    ['zh', zh, 'Telegram 凭据或权限有误，请检查机器人令牌并确认访问权限后重新连接。'],
    ['en', en, 'Telegram credentials or permissions are invalid. Check the bot token and access permissions, then reconnect.'],
  ] as const) {
    for (const width of [360, 900]) {
      it(`${language}: the full status reason wraps in a 140px cell at viewport ${width}px`, async () => {
        state.reason = reason;
        useAppStore.setState({ language });
        render(<ChannelsSettings />);
        const error = await screen.findByText(reason);
        const cell = error.closest('[data-testid="channel-account-status"]');
        expect(cell).not.toBeNull();
        await layout(`<main style="width:140px;margin:16px">${cell!.outerHTML}</main>`, width);
        const rendered = page.getByTitle(reason, { exact: true });
        expect(await rendered.isVisible()).toBe(true);
        const geometry = await rendered.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(element);
          range.setStart(element.firstChild!, element.textContent!.length - 1);
          const last = range.getBoundingClientRect();
          return {
            height: box.height,
            lineHeight: parseFloat(getComputedStyle(element).lineHeight),
            overflow: element.scrollWidth - element.clientWidth,
            lastCharacterInside: last.left >= box.left - 1 && last.right <= box.right + 1 && last.bottom <= box.bottom + 1,
          };
        });
        expect(geometry.height).toBeGreaterThan(geometry.lineHeight);
        expect(geometry.overflow).toBeLessThanOrEqual(1);
        expect(geometry.lastCharacterInside).toBe(true);
        console.info('channel status narrow layout', language, width, geometry);
      });
    }

    it(`${language}: the short example fits and the full helper wraps below the input at 360px`, async () => {
      useAppStore.setState({ language });
      const { container } = render(<ChannelModal
        channelTypes={[{ type: 'telegram', name: 'Telegram' }]}
        account={{ id: 'layout-channel', name: 'Weekly report', type: 'telegram', status: 'disconnected', enabled: true, createdAt: 1, config: { type: 'telegram', botToken: '123:example' } }}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />);
      await layout(container.innerHTML, 360);
      const input = page.getByPlaceholder(locale.settings.channels.modal.allowedUserIdsPlaceholder, { exact: true });
      await input.scrollIntoViewIfNeeded();
      const geometry = await input.evaluate((element) => {
        const style = getComputedStyle(element);
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d')!;
        context.font = style.font;
        const helper = document.getElementById(element.getAttribute('aria-describedby')!)!;
        const inputBox = element.getBoundingClientRect();
        const helperBox = helper.getBoundingClientRect();
        return {
          placeholderWidth: context.measureText((element as HTMLInputElement).placeholder).width,
          availableWidth: element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
          helperBelowInput: helperBox.top >= inputBox.bottom,
          helperHeight: helperBox.height,
          helperLineHeight: parseFloat(getComputedStyle(helper).lineHeight),
          helperOverflow: helper.scrollWidth - helper.clientWidth,
          helperText: helper.textContent,
        };
      });
      expect(geometry.placeholderWidth).toBeLessThanOrEqual(geometry.availableWidth);
      expect(geometry.helperBelowInput).toBe(true);
      expect(geometry.helperHeight).toBeGreaterThan(geometry.helperLineHeight);
      expect(geometry.helperOverflow).toBeLessThanOrEqual(1);
      expect(geometry.helperText).toBe(locale.settings.channels.modal.allowedUserIdsHint);
      console.info('Telegram helper narrow layout', language, geometry);
    });
  }
});

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

  // 视口下界取桌面壳主窗口 minWidth=960（src-tauri/tauri.conf.json `main` 窗口与
  // src-tauri/src/main.rs `min_inner_size(960.0, 640.0)` 一致），360px 低于该最小值
  // 不再作为受支持宽度（编排裁决 2026-11-12）；900px 按任务书保留。
  for (const [language, locale, reason] of [
    ['zh', zh, '重连中（第 3 次）：连不上Telegram服务器（令牌 AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw4uR7mQzXwYbN2cV9fK 校验失败），正在自动重试'],
    ['en', en, 'Reconnecting (attempt 3): Telegram rejected token AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw4uR7mQzXwYbN2cV9fK, retrying automatically'],
  ] as const) {
    for (const width of [900, 960]) {
      it(`${language}: the full status reason wraps and stays inside the visible content region at viewport ${width}px`, async () => {
        state.reason = reason;
        useAppStore.setState({ language });
        const { container } = render(<ChannelsSettings />);
        const error = await screen.findByText(reason);
        const cell = error.closest('[data-testid="channel-account-status"]');
        expect(cell).not.toBeNull();
        // 复刻 SettingsModal 的真实祖先链：280px 侧栏 + flex-1 主区 + px-8/max-w-6xl 内容列。
        // 隔离挂载看不见祖先裁剪（2026-11-10 一轮的教训），必须整棵组件进真实框架。
        await layout(
          `<div class="flex h-full min-h-0" style="height:800px">`
          + `<aside class="flex w-[280px] shrink-0 flex-col border-r border-zinc-800 bg-zinc-900/95"></aside>`
          + `<main class="min-w-0 flex-1 overflow-y-auto bg-zinc-950">`
          + `<div class="mr-auto min-h-full px-8 pb-16 pt-8 max-w-6xl">${container.innerHTML}</div>`
          + `</main></div>`,
          width,
        );
        const rendered = page.getByTitle(reason, { exact: true });
        expect(await rendered.isVisible()).toBe(true);
        const geometry = await rendered.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(element);
          range.setStart(element.firstChild!, element.textContent!.length - 1);
          const last = range.getBoundingClientRect();
          const scroller = element.closest('.overflow-x-auto');
          const scrollerBox = scroller ? scroller.getBoundingClientRect() : null;
          return {
            height: box.height,
            lineHeight: parseFloat(getComputedStyle(element).lineHeight),
            overflow: element.scrollWidth - element.clientWidth,
            textOverflow: getComputedStyle(element).textOverflow,
            lastCharacterInside: last.left >= box.left - 1 && last.right <= box.right + 1 && last.bottom <= box.bottom + 1,
            insideScroller: !!scrollerBox && box.left >= scrollerBox.left - 1 && box.right <= scrollerBox.right + 1,
          };
        });
        expect(geometry.height).toBeGreaterThan(geometry.lineHeight);
        expect(geometry.overflow).toBeLessThanOrEqual(1);
        expect(geometry.textOverflow).not.toBe('ellipsis');
        expect(geometry.lastCharacterInside).toBe(true);
        expect(geometry.insideScroller).toBe(true);
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

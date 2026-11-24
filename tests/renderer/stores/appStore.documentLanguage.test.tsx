// @vitest-environment jsdom
// <html lang> 跟随 UI 语言：setLanguage 是所有切换路径的唯一出口（App 设置读回、
// AppearanceSettings、useI18n().switchLanguage 都走它），store 创建时按
// localStorage 快照兜底一次；index.html 首帧脚本负责 React 挂载前不闪错语言。
import { act, renderHook } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/renderer/services/ipcService', async (original) => ({
  ...await original<typeof import('../../../src/renderer/services/ipcService')>(),
  default: {
    ...(await original<typeof import('../../../src/renderer/services/ipcService')>()).default,
    on: vi.fn(() => vi.fn()),
    isAvailable: () => false,
  },
}));

const invoke = vi.fn();
const STORAGE_KEY = 'code-agent-language';
const ROOT = process.cwd();

async function importFresh() {
  vi.resetModules();
  const [appStoreModule, useI18nModule] = await Promise.all([
    import('../../../src/renderer/stores/appStore'),
    import('../../../src/renderer/hooks/useI18n'),
  ]);
  return { useAppStore: appStoreModule.useAppStore, useI18n: useI18nModule.useI18n };
}

beforeEach(() => {
  invoke.mockReset().mockRejectedValue(new Error('Network unavailable'));
  Object.defineProperty(window, 'domainAPI', { configurable: true, value: { invoke } });
  localStorage.clear();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('<html lang> follows the UI language', () => {
  it('setLanguage(zh) sets document lang to zh-CN and setLanguage(en) sets it back to en', async () => {
    const { useAppStore } = await importFresh();
    act(() => useAppStore.getState().setLanguage('zh'));
    expect(document.documentElement.lang).toBe('zh-CN');
    act(() => useAppStore.getState().setLanguage('en'));
    expect(document.documentElement.lang).toBe('en');
  });

  it('useI18n().switchLanguage drives document lang through the same store path', async () => {
    const { useI18n } = await importFresh();
    const { result } = renderHook(() => useI18n());
    act(() => result.current.setLanguage('en'));
    expect(document.documentElement.lang).toBe('en');
    act(() => result.current.setLanguage('zh'));
    expect(document.documentElement.lang).toBe('zh-CN');
  });

  it.each([
    ['en', 'en'],
    ['zh', 'zh-CN'],
  ] as const)('stored language %s is honoured at store creation: document lang = %s', async (stored, expected) => {
    localStorage.setItem(STORAGE_KEY, stored);
    await importFresh();
    expect(document.documentElement.lang).toBe(expected);
  });

  it('invalid stored value falls back to the default language zh-CN', async () => {
    localStorage.setItem(STORAGE_KEY, 'fr');
    await importFresh();
    expect(document.documentElement.lang).toBe('zh-CN');
  });

  it('index.html first-paint script maps code-agent-language to lang before the module script', () => {
    const html = readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
    // 静态默认与 app 默认语言（zh）一致，首次启动不是 en
    expect(html).toContain('<html lang="zh-CN"');
    const readerIndex = html.indexOf("localStorage.getItem('code-agent-language')");
    expect(readerIndex).toBeGreaterThan(-1);
    const scriptSource = html.slice(html.lastIndexOf('<script>', readerIndex), html.indexOf('</script>', readerIndex));
    // zh -> zh-CN、en -> en，未知/缺失回退 zh-CN
    expect(scriptSource).toContain("'zh-CN'");
    expect(scriptSource).toContain("'en'");
    // 首帧脚本必须排在 module script 之前，React 挂载前就把 lang 设好
    const moduleScriptIndex = html.indexOf('type="module"');
    expect(moduleScriptIndex).toBeGreaterThan(-1);
    expect(readerIndex).toBeLessThan(moduleScriptIndex);
  });
});

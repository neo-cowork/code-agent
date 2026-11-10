import { afterEach, describe, expect, it } from 'vitest';
import { getDisplaySessionTitle } from '../../../src/renderer/utils/sessionPresentation';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import {
  deriveFallbackSessionTitle,
  sessionTitleSource,
} from '../../../src/shared/sessionTitlePlaceholder';

const APPSHOT_ONLY = '<appshot app="a" name="Notes" captured="2026-09-07T00:00:00.000Z">\nwindow\n</appshot>';

afterEach(() => useAppStore.setState({ language: 'zh' }));

describe('Appshot 固定会话名跟随 UI 语言', () => {
  it('shared：纯 appshot 的标题源与降级标题按语言给名', () => {
    expect(sessionTitleSource(APPSHOT_ONLY)).toBe('Appshot 会话');
    expect(sessionTitleSource(APPSHOT_ONLY, 'en')).toBe('Appshot session');
    expect(deriveFallbackSessionTitle(APPSHOT_ONLY, 'en')).toBe('Appshot session');
  });

  it('renderer：英文 UI 下存量中文固定名与裸 appshot 标题都显示英文，中文 UI 不变', () => {
    useAppStore.setState({ language: 'en' });
    expect(getDisplaySessionTitle('Appshot 会话')).toBe('Appshot session');
    expect(getDisplaySessionTitle(APPSHOT_ONLY)).toBe('Appshot session');
    expect(getDisplaySessionTitle('')).toBe('Untitled session');
    useAppStore.setState({ language: 'zh' });
    expect(getDisplaySessionTitle('Appshot session')).toBe('Appshot 会话');
    expect(getDisplaySessionTitle(APPSHOT_ONLY)).toBe('Appshot 会话');
  });
});

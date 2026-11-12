import { describe, expect, it } from 'vitest';
import { getDisplaySessionTitle } from '../../../src/renderer/utils/sessionPresentation';
import {
  deriveFallbackSessionTitle,
  sessionTitleSource,
} from '../../../src/shared/sessionTitlePlaceholder';

const APPSHOT_ONLY = '<appshot app="a" name="Notes" captured="2026-09-07T00:00:00.000Z">\nwindow\n</appshot>';

describe('Appshot 固定会话名跟随 UI 语言', () => {
  it('shared：纯 appshot 的标题源与降级标题按语言给名', () => {
    expect(sessionTitleSource(APPSHOT_ONLY)).toBe('Appshot 会话');
    expect(sessionTitleSource(APPSHOT_ONLY, 'en')).toBe('Appshot conversation');
    expect(deriveFallbackSessionTitle(APPSHOT_ONLY, 'en')).toBe('Appshot conversation');
  });

  it('renderer：英文 UI 下存量中文固定名与裸 appshot 标题都显示英文，中文 UI 不变', () => {
    expect(getDisplaySessionTitle('Appshot 会话', 'en')).toBe('Appshot conversation');
    expect(getDisplaySessionTitle(APPSHOT_ONLY, 'en')).toBe('Appshot conversation');
    expect(getDisplaySessionTitle('Appshot conversation', 'zh')).toBe('Appshot 会话');
    expect(getDisplaySessionTitle(APPSHOT_ONLY, 'zh')).toBe('Appshot 会话');
  });
});

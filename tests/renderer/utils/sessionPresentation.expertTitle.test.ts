import { describe, expect, it } from 'vitest';
import { getDisplaySessionTitle } from '../../../src/renderer/utils/sessionPresentation';

describe('expert thread titles', () => {
  it('en shows the localized nickname for a built-in roleId title', () => {
    expect(getDisplaySessionTitle('牧之', 'en')).toBe('Muzhi');
  });
  it('zh and custom titles unchanged', () => {
    expect(getDisplaySessionTitle('牧之', 'zh')).toBe('牧之');
    expect(getDisplaySessionTitle('旅行规划师', 'en')).toBe('旅行规划师');
  });
});

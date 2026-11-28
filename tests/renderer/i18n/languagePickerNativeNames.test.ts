// 语言选择器里每种语言显示自己的名字：英文界面下误切到英文的用户靠「简体中文」才能找回中文。
import { describe, expect, it } from 'vitest';
import { languages } from '../../../src/renderer/i18n';

describe('language picker native names', () => {
  it('en pack keeps each language under its own name', () => {
    expect(languages.en.language.options.zh.native).toBe('简体中文');
    expect(languages.en.language.options.en.native).toBe('English');
  });

  it('en pack keeps the Chinese badge as 中 (same as main)', () => {
    expect(languages.en.settings.appearance.languageBadges.zh).toBe('中');
  });

  it('zh pack agrees', () => {
    expect(languages.zh.language.options.zh.native).toBe('简体中文');
    expect(languages.zh.language.options.en.native).toBe('English');
  });
});

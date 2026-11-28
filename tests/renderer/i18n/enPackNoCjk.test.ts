// 英文语言包整包体检：i18n 目录不在 CJK 字面量门（scripts/renderer-cjk-literal-ratchet.mjs）的扫描范围里，
// 写进英文包的汉字或全角标点（「Login hint：」「a、b」「“」写成「「」）门看不见，由这里兜住。
import { describe, expect, it } from 'vitest';
import { languages } from '../../../src/renderer/i18n';

// 汉字 + 中文标点（含全角空格、全角冒号、顿号、书名号）
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/u;

// 英文界面里本来就该出现中文的地方：语言自己的名字、会议软件在系统里的中文窗口名、
// 教学实验页里拿中文句子当样例的演示数据。只按键路径前缀放行，新增的英文文案不在其列。
const EXPECTED_CJK_PREFIXES = [
  'settings.appearance.languageBadges.',
  'settings.voiceInput.languages.',
  'settings.nativeDesktop.meetingAppNames.',
  'language.options.',
  'voice.settings.languageZh',
  'labGpt1.',
  'labNanogpt.',
  'labLlamafactory.',
];

function cjkEntries(value: unknown, path: string, out: string[]): string[] {
  if (typeof value === 'string') {
    if (CJK.test(value)) out.push(`${path} = ${value}`);
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) cjkEntries(child, path ? `${path}.${key}` : key, out);
  }
  return out;
}

describe('英文语言包不含中文和中文标点', () => {
  it('除了语言名、会议软件名和实验页样例数据，英文包里没有任何汉字或全角标点', () => {
    const unexpected = cjkEntries(languages.en, '', [])
      .filter((entry) => !EXPECTED_CJK_PREFIXES.some((prefix) => entry.startsWith(prefix)));
    expect(unexpected).toEqual([]);
  });

  it('列表分隔符和标签冒号跟随界面语言：英文半角，中文保持顿号和全角冒号', () => {
    expect(languages.en.punctuation).toEqual({ listSeparator: ', ', colon: ': ' });
    expect(languages.zh.punctuation).toEqual({ listSeparator: '、', colon: '：' });
  });
});

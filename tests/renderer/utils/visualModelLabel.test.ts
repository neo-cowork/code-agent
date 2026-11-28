import { describe, expect, it } from 'vitest';
import { languages } from '../../../src/renderer/i18n';
import { getVisualModelLabel } from '../../../src/renderer/utils/visualModelLabel';
import { IMAGE_MODELS, VIDEO_MODELS } from '../../../src/shared/constants/visualModels';

const HAN = /[㐀-䶿一-鿿豈-﫿]/u;
const registry = [...IMAGE_MODELS, ...VIDEO_MODELS];

describe('内置多模态模型显示名跟随界面语言（FB-1292）', () => {
  it('注册表里每个模型：中文与注册表原文逐字相同，英文不含中文', () => {
    expect(registry.some((model) => HAN.test(model.label))).toBe(true);
    for (const model of registry) {
      expect(getVisualModelLabel(model, languages.zh.visualModelLabels), model.id).toBe(model.label);
      expect(getVisualModelLabel(model, languages.en.visualModelLabels), model.id).not.toMatch(HAN);
    }
  });

  it('宿主内置的音乐模型同样有两种语言的名字', () => {
    const music = { id: 'minimax-music-2.6', label: 'MiniMax 音乐' };
    expect(getVisualModelLabel(music, languages.zh.visualModelLabels)).toBe('MiniMax 音乐');
    expect(getVisualModelLabel(music, languages.en.visualModelLabels)).toBe('MiniMax Music');
  });

  it('语言包没收录的模型（用户自定义的）显示它自己的名字', () => {
    const custom = { id: 'custom:my-model', label: '我的模型' };
    expect(getVisualModelLabel(custom, languages.en.visualModelLabels)).toBe('我的模型');
  });

  it('语言包里没有注册表已经不存在的条目', () => {
    const ids = new Set([...registry.map((model) => model.id), 'minimax-music-2.6']);
    expect(Object.keys(languages.en.visualModelLabels).filter((id) => !ids.has(id))).toEqual([]);
    expect(Object.keys(languages.zh.visualModelLabels).sort()).toEqual(Object.keys(languages.en.visualModelLabels).sort());
  });
});

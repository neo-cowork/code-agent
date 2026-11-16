// 隐私防线页底部两张表（语音转写路径、凭证清单）跟随界面语言。
// 英文：每个上屏字段都不含中文和中文标点；中文：与契约里的原文逐字相同。
import { describe, expect, it } from 'vitest';
import { listAuthInventoryItems } from '../../../src/shared/contract/authInventory';
import { listVoiceTranscriptionPaths } from '../../../src/shared/contract/voiceTranscription';
import {
  getAuthInventoryItemCopy,
  getVoiceTranscriptionPathCopy,
} from '../../../src/renderer/utils/privacyBoundaryCopy';

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/u;

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => strings(item, out));
  return out;
}

describe('语音转写路径文案', () => {
  it('四条路径的英文文案齐全，不含中文和中文标点', () => {
    const paths = listVoiceTranscriptionPaths();
    expect(paths.map((path) => path.id)).toEqual(['chat_voice', 'voice_paste', 'desktop_audio', 'channel_audio']);
    for (const path of paths) {
      const copy = getVoiceTranscriptionPathCopy(path, 'en');
      const texts = strings(copy);
      expect(texts.filter((text) => CJK.test(text)), path.id).toEqual([]);
      expect(texts.every((text) => text.trim().length > 0), path.id).toBe(true);
      expect(copy.providers, path.id).toHaveLength(path.providers.length);
    }
    expect(getVoiceTranscriptionPathCopy(paths[0], 'en').title).toBe('Chat voice input');
  });

  it('中文界面逐字沿用契约原文', () => {
    for (const path of listVoiceTranscriptionPaths()) {
      expect(getVoiceTranscriptionPathCopy(path, 'zh')).toEqual({
        title: path.title,
        trigger: path.trigger,
        providers: path.providers,
        cloud: path.cloud,
        temporaryStorage: path.temporaryStorage,
        logPolicy: path.logPolicy,
      });
    }
  });
});

describe('凭证清单文案', () => {
  it('每一条的英文文案齐全，不含中文和中文标点，示例名与契约一致', () => {
    const items = listAuthInventoryItems();
    expect(items).toHaveLength(6);
    for (const item of items) {
      const copy = getAuthInventoryItemCopy(item, 'en');
      const texts = strings(copy);
      expect(texts.filter((text) => CJK.test(text)), item.id).toEqual([]);
      expect(texts.every((text) => text.trim().length > 0), item.id).toBe(true);
      expect(copy.title, item.id).not.toBe(item.title);
      expect(copy.examples, item.id).toEqual(item.examples);
    }
  });

  it('中文界面逐字沿用契约原文', () => {
    for (const item of listAuthInventoryItems()) {
      expect(getAuthInventoryItemCopy(item, 'zh')).toEqual({
        title: item.title,
        examples: item.examples,
        storage: item.storage,
        display: item.display,
        diagnosticPolicy: item.diagnosticPolicy,
      });
    }
  });
});

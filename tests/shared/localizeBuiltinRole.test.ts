import { describe, expect, it } from 'vitest';
import { localizeBuiltinRole } from '../../src/shared/localizeBuiltinRole';

describe('localizeBuiltinRole', () => {
  it('shows pinyin name and English profession for built-in experts in en', () => {
    expect(localizeBuiltinRole('牧之', { name: '牧之', profession: '资深产品经理' }, 'en'))
      .toEqual({ name: 'Muzhi', profession: 'Senior Product Manager' });
    expect(localizeBuiltinRole('数据分析师', { name: '知微', profession: '数据分析师' }, 'en'))
      .toEqual({ name: 'Zhiwei', profession: 'Data Analyst' });
    expect(localizeBuiltinRole('研究员', { name: '研究员', profession: '研究员' }, 'en').name).toBe('Researcher');
  });

  it('names the cloud-shelf packs by their real profession', () => {
    expect(localizeBuiltinRole('岚析', { name: '岚析', profession: '增长分析师' }, 'en')).toEqual({ name: 'Lanxi', profession: 'Growth Analyst' });
    expect(localizeBuiltinRole('映川', { name: '映川', profession: '视觉设计师' }, 'en')).toEqual({ name: 'Yingchuan', profession: 'Visual Designer' });
  });

  it('returns inputs unchanged in zh', () => {
    const parts = { name: '牧之', profession: '资深产品经理' };
    expect(localizeBuiltinRole('牧之', parts, 'zh')).toBe(parts);
  });

  it('leaves custom / unknown roles untouched in en', () => {
    const parts = { name: '我的助手', profession: '写作' };
    expect(localizeBuiltinRole('我的助手', parts, 'en')).toBe(parts);
    expect(localizeBuiltinRole('toString', { name: 'x' }, 'en')).toEqual({ name: 'x' });
  });

  it('keeps an empty profession empty', () => {
    expect(localizeBuiltinRole('溯真', { name: '溯真', profession: '' }, 'en')).toEqual({ name: 'Suzhen', profession: '' });
    expect(localizeBuiltinRole('溯真', { name: '溯真' }, 'en')).toEqual({ name: 'Suzhen', profession: undefined });
  });

  it('has no CJK in any English name or profession', () => {
    for (const id of ['数据分析师', '牧之', '溯真', '青禾', '明镜', '持衡', '记言', '万卷', '岚析', '映川', '研究员']) {
      const r = localizeBuiltinRole(id, { name: id, profession: id }, 'en');
      expect(`${r.name}${r.profession}`).not.toMatch(/\p{Script=Han}/u);
    }
  });
});

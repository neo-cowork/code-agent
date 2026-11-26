import { describe, expect, it } from 'vitest';
import { stripLegacyTeamRecipeSeed } from '../../../src/shared/utils/legacyTeamRecipeDisplay';

describe('stripLegacyTeamRecipeSeed', () => {
  it('剥掉确定性组队旧行的前缀', () => {
    expect(stripLegacyTeamRecipeSeed('【组队 · 产品规格】会员增长方案')).toBe('会员增长方案');
  });
  it('主理人旧 brief 行不渲染', () => {
    const brief = '你是主理人。主题是 会员增长\n执行铁律：第一步必须调用 spawn_agent；\nagents JSON：[{"role":"溯真"}]';
    expect(stripLegacyTeamRecipeSeed(brief)).toBe('');
  });
  it('普通内容原样返回，只剥开头前缀', () => {
    expect(stripLegacyTeamRecipeSeed('Q4 membership growth plan')).toBe('Q4 membership growth plan');
    expect(stripLegacyTeamRecipeSeed('提到【组队 · x】在中间')).toBe('提到【组队 · x】在中间');
  });
});

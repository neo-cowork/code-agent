import { describe, expect, it } from 'vitest';
import { BUILTIN_SKILLS } from '../../../../src/host/services/skills/builtinSkills';
import { resolveSkillInvocationFromSkills } from '../../../../src/host/services/skills/skillInvocationResolver';
import { buildDelegatedTaskPrompt } from '../../../../src/host/services/commandCenter/delegationGuidance';

// 守门：机器拼装的委派后台提示词的静态句子不得命中任何内置技能别名。
// 别名一旦命中，后台任务会被误注入该技能（首例：静态句里的 "scope" 命中
// task-brief-builder），其 allowed-tools 强制审批在后台无人能答。
// 修法是改静态句措辞，不是改技能别名。plan / original request 用中性文本，
// 保证命中的只能是静态字节。
const NEUTRAL_PLAN = 'step one open the site example.com step two report the page title';
const NEUTRAL_ORIGINAL_REQUEST = 'open example.com and tell me the page title';

describe('delegated prompt static text vs builtin skill aliases (gate)', () => {
  const promptShapes: Array<[label: string, prompt: string]> = [
    ['without original request', buildDelegatedTaskPrompt(NEUTRAL_PLAN)],
    ['with neutral original request', buildDelegatedTaskPrompt(NEUTRAL_PLAN, NEUTRAL_ORIGINAL_REQUEST)],
  ];

  for (const [label, prompt] of promptShapes) {
    it(`${label}: no builtin alias matches the static text`, () => {
      // 生产路径形状：全集解析必须落空。
      expect(resolveSkillInvocationFromSkills(prompt, BUILTIN_SKILLS)).toBeNull();
      // 逐技能解析，防两个技能分差 <0.12 时全集解析以「歧义」为名漏报。
      const hits: string[] = [];
      for (const skill of BUILTIN_SKILLS) {
        const hit = resolveSkillInvocationFromSkills(prompt, [skill]);
        if (hit) hits.push(`${skill.name} via ${hit.matchKind} ${JSON.stringify(hit.matchedText)}`);
      }
      expect(hits).toEqual([]);
    });
  }
});

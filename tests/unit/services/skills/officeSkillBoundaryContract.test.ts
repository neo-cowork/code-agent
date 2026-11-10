// 办公类内置 skill 的 allowed-tools 边界契约：真实产出路径用到的运行时工具必须被边界放行，
// 无关工具（mail_send）仍是越界。bypass 会话里这些 skill 不能被自己的边界卡死。
import { describe, expect, it } from 'vitest';
import { BUILTIN_SKILLS } from '../../../../src/host/services/skills/builtinSkillsData';
import { FRONTEND_SLIDES_BUILTIN_SKILLS } from '../../../../src/host/services/skills/builtinFrontendSlides';
import { skillBoundaryAllowsTool } from '../../../../src/host/tools/skillBoundaryScope';

const ALL = [...BUILTIN_SKILLS, ...FRONTEND_SLIDES_BUILTIN_SKILLS];

const OUTPUT_TOOLS: Record<string, string[]> = {
  xlsx: ['Write', 'Edit', 'Bash', 'ExcelAutomate', 'excel_generate'],
  'data-cleaning': ['Write', 'Edit', 'Bash'],
  'data-analysis-helper': ['Write', 'Edit', 'Bash'],
  'meeting-summary': ['Write'],
  'literature-review': ['Write'],
  'paper-distillation': ['Write'],
  'research-monitor': ['Write'],
  'research-brief-and-split': ['Write'],
  'frontend-slides': ['Write', 'Edit', 'Bash', 'spawn_agent', 'collect_agent'],
  ppt: ['Write', 'Edit', 'Bash', 'spawn_agent', 'collect_agent'],
};

describe('office skill boundary contract', () => {
  for (const [name, tools] of Object.entries(OUTPUT_TOOLS)) {
    it(`${name}: output tools allowed, mail_send still a violation`, () => {
      const skill = ALL.find((s) => s.name === name);
      expect(skill, `skill ${name}`).toBeDefined();
      const boundary = { skillName: name, allowedTools: skill!.allowedTools ?? [] };
      for (const tool of tools) {
        expect(skillBoundaryAllowsTool(boundary, tool, {}), `${name} → ${tool}`).toBe(true);
      }
      expect(skillBoundaryAllowsTool(boundary, 'mail_send', {})).toBe(false);
    });
  }
});

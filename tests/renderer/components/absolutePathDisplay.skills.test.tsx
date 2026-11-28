// 设置→Skills：被官方同名技能压住的来源路径，文字与 title 只去账户名（~/…），不含 /Users/。
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SkillsInstalledTab, type InstalledSkill } from '../../../src/renderer/components/features/settings/tabs/SkillsInstalledTab';
import { useAppStore } from '../../../src/renderer/stores/appStore';

function conflictSkill(): InstalledSkill {
  return {
    name: 'xlsx', description: 'xlsx desc', promptContent: '', basePath: '/u/xlsx', allowedTools: [],
    disableModelInvocation: false, userInvocable: true, executionContext: 'inline', source: 'plugin',
    globalEnabled: true, projectOverride: null, enabled: true,
    officialConflict: { winnerSource: 'plugin', blockedSkills: [{ source: 'user', basePath: '/Users/alice/.claude/skills/xlsx' }] },
  };
}

describe.each(['zh', 'en'] as const)('SkillsInstalledTab 冲突来源路径 (%s)', (language) => {
  it('文字与 title 为 ~/.claude/skills/xlsx/SKILL.md，HTML 不含 /Users/', () => {
    useAppStore.setState({ language });
    const noop = () => {};
    const html = renderToStaticMarkup(React.createElement(SkillsInstalledTab, {
      skills: [conflictSkill()], libraries: [], actionLoading: null, onToggleSkill: noop, onProjectOverrideChange: noop,
      onUpdateLibrary: noop, onRemoveLibrary: noop, onExportSkill: noop, onInstallFromZip: noop, onDropZipFile: noop,
    }));
    expect(html).toContain('title="~/.claude/skills/xlsx/SKILL.md"');
    expect(html).toMatch(/~\/\.claude\/skills\/xlsx\/SKILL\.md</);
    expect(html).not.toContain('/Users/');
  });
});

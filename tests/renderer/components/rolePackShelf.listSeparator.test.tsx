// @vitest-environment jsdom
// 云货架专家卡的「技能 / 工具」两行是把名字拼成一串：分隔符跟随界面语言，
// 英文用半角逗号，中文仍是顿号。
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RolePackListItem } from '../../../src/renderer/services/rolesClient';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { RolePackHealthNotice, RolePackShelf } from '../../../src/renderer/components/features/expert/RolePackShelf';

const item = {
  entry: {
    roleId: 'growth-analyst',
    displayName: 'Lanxi',
    description: 'Growth diagnostics',
    publisher: 'Neo',
    packVersion: '1.0.0',
    tags: [],
    visual: { icon: 'chart', profession: 'Growth analyst' },
    skills: [{ registryName: 'seo-audit' }, { registryName: 'cohort-analysis' }, { registryName: 'funnel-review' }],
  },
  tools: ['Read', 'Write', 'Glob'],
  installed: true,
  installState: 'degraded',
  missingSkills: ['seo-audit', 'cohort-analysis'],
  hasUpdate: false,
} as unknown as RolePackListItem;

const noop = vi.fn();

function shelfLines(): string[] {
  const view = render(
    <RolePackShelf
      items={[item]}
      loading={false}
      error={null}
      busyRoleId={null}
      onRetryLoad={noop}
      onInstall={noop}
      onUninstall={noop}
      onRetryMissingSkills={noop}
    />,
  );
  return Array.from(view.container.querySelectorAll('p')).map((node) => node.textContent ?? '');
}

afterEach(() => {
  cleanup();
  useAppStore.setState({ language: 'zh' });
});

describe('RolePackShelf 名字列表的分隔符', () => {
  it('英文界面用半角逗号，卡片上没有顿号', () => {
    useAppStore.setState({ language: 'en' });
    const lines = shelfLines();
    expect(lines).toContain('Skills: seo-audit, cohort-analysis, funnel-review');
    expect(lines).toContain('Tools: Read, Write, Glob');
    expect(lines.filter((line) => line.includes('、'))).toEqual([]);
  });

  it('中文界面仍用顿号', () => {
    const lines = shelfLines();
    expect(lines.some((line) => line.endsWith('seo-audit、cohort-analysis、funnel-review'))).toBe(true);
    expect(lines.some((line) => line.endsWith('Read、Write、Glob'))).toBe(true);
  });

  it('缺技能提示里的技能名也跟随界面语言', () => {
    useAppStore.setState({ language: 'en' });
    const english = render(<RolePackHealthNotice item={item} onRetryMissingSkills={noop} />).container.textContent ?? '';
    expect(english).toContain('seo-audit, cohort-analysis');
    expect(english).not.toContain('、');
    cleanup();
    useAppStore.setState({ language: 'zh' });
    const chinese = render(<RolePackHealthNotice item={item} onRetryMissingSkills={noop} />).container.textContent ?? '';
    expect(chinese).toContain('seo-audit、cohort-analysis');
  });
});

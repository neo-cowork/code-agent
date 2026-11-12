// @vitest-environment jsdom
import React, { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ParsedSkill } from '../../../src/shared/contract/agentSkill';
import { CronPersonalSkillFields } from '../../../src/renderer/components/features/cron/CronPersonalSkillFields';
import { createDefaultCronJobDraft } from '../../../src/renderer/components/features/cron/types';
import { useSkillStore } from '../../../src/renderer/stores/skillStore';
import { useAppStore } from '../../../src/renderer/stores/appStore';

function Harness({ selected = [] }: { selected?: string[] }) {
  const [draft, setDraft] = useState(() => ({ ...createDefaultCronJobDraft(), agentAllowedPersonalSkillIds: selected }));
  return <CronPersonalSkillFields draft={draft} setField={(key, value) => setDraft((prev) => ({ ...prev, [key]: value }))} />;
}
const skills = [
  { name: 'wechat-local-query', description: '读取本地微信未读消息', source: 'user' },
  { name: 'second-personal', description: '另一个个人技能', source: 'user' },
  { name: 'docx', description: '内置文档技能', source: 'builtin' },
] as ParsedSkill[];
const originalFetch = useSkillStore.getState().fetchAvailableSkills;
afterEach(() => { cleanup(); useAppStore.setState({ language: 'zh' }); useSkillStore.setState({ availableSkills: [], fetchAvailableSkills: originalFetch }); });

describe('CronPersonalSkillFields', () => {
  it('fetches installed skills, shows only personal names/descriptions, defaults unchecked, selects and clears independently', async () => {
    const fetchAvailableSkills = vi.fn(async () => { useSkillStore.setState({ availableSkills: skills }); });
    useSkillStore.setState({ availableSkills: [], fetchAvailableSkills });
    render(<Harness />);
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(2));
    expect(fetchAvailableSkills).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('docx')).toBeNull();
    expect(screen.getByText('允许本任务使用这些个人技能')).toBeTruthy();
    expect(screen.getByText('勾选后，这个任务运行时可以用它；它要执行的命令仍会请你批准')).toBeTruthy();
    const first = screen.getByRole('checkbox', { name: /wechat-local-query/ }) as HTMLInputElement;
    const second = screen.getByRole('checkbox', { name: /second-personal/ }) as HTMLInputElement;
    expect(first.checked).toBe(false); expect(second.checked).toBe(false);
    fireEvent.click(first); expect(first.checked).toBe(true); expect(second.checked).toBe(false);
    fireEvent.click(first); expect(first.checked).toBe(false);
  });
  it('shows saved selection and English approval hint', () => {
    useAppStore.setState({ language: 'en' });
    useSkillStore.setState({ availableSkills: skills, fetchAvailableSkills: vi.fn(async () => undefined) });
    render(<Harness selected={['wechat-local-query']} />);
    expect((screen.getByRole('checkbox', { name: /wechat-local-query/ }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('Allow this task to use these personal skills')).toBeTruthy();
    expect(screen.getByText('Selected skills can be used when this task runs. Commands they run still require your approval.')).toBeTruthy();
  });
  it.each(['zh', 'en'] as const)('shows an empty state with no empty checkbox area (%s)', (language) => {
    useAppStore.setState({ language });
    useSkillStore.setState({ availableSkills: [], fetchAvailableSkills: vi.fn(async () => undefined) });
    render(<Harness />);
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByText(language === 'zh' ? '你还没有安装个人技能' : 'You have not installed any personal skills yet')).toBeTruthy();
  });
});

// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RolePanelDetail } from '../../../src/shared/contract/roleAssets';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import type { RolePackListItem } from '../../../src/renderer/services/rolesClient';

const invokeDomain = vi.hoisted(() => vi.fn());
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain, on: () => () => {} },
}));

import { RoleDetailPage } from '../../../src/renderer/components/features/expert/RoleDetailPage';
import { RolePackShelf } from '../../../src/renderer/components/features/expert/RolePackShelf';
import { useAppStore } from '../../../src/renderer/stores/appStore';

const FORBIDDEN_RAW_TOOL_NAMES = [
  'Read',
  'Glob',
  'Grep',
  'WebFetch',
  'MemoryRead',
  'AgentMessage',
  'TaskManager',
] as const;

const FULL_AVAILABLE_TOOLS = [
  'AgentMessage',
  'Bash',
  'Edit',
  'Glob',
  'Grep',
  'History',
  'MemoryRead',
  'MemoryWrite',
  'Read',
  'TaskManager',
  'WebFetch',
  'WebSearch',
  'Write',
  'bash',
  'glob',
  'grep',
  'mail',
  'mail_draft',
  'mail_send',
  'memory_read',
  'read',
  'read_file',
  'tmeetMeetingCreate',
  'tmeetMeetingList',
  'web_fetch',
  'web_search',
];

function makeDetail(overrides: Partial<NonNullable<RolePanelDetail['equipment']>> = {}): RolePanelDetail {
  return {
    roleId: '牧之',
    definition: null,
    definitionPath: '',
    memories: [],
    history: [],
    proactivity: { level: 'silent' },
    visual: { displayName: '牧之', profession: '产品顾问' },
    isBuiltin: true,
    personalization: { userExpectation: '', soul: '', boundaries: { disallowExternalSending: false } },
    equipment: {
      skills: ['research'],
      tools: ['read_file', 'Glob', 'MemoryRead', 'AgentMessage', 'TaskManager', 'fooBar', 'fooBar'],
      model: 'balanced',
      modelOverride: { provider: 'anthropic', model: 'claude-sonnet' },
      maxIterations: 20,
      availableSkills: ['research'],
      availableTools: FULL_AVAILABLE_TOOLS,
      ...overrides,
    },
  };
}

function assertNoInternalToolNamesInNormalView(root: HTMLElement, language: 'zh' | 'en'): void {
  const fullText = root.textContent ?? '';
  // English plain-language label is "Read and find files"; remove that phrase before checking standalone "Read".
  const textWithoutReadPhrase = language === 'en'
    ? fullText.replace(/Read and find files/g, '')
    : fullText;

  for (const rawName of FORBIDDEN_RAW_TOOL_NAMES) {
    expect(textWithoutReadPhrase).not.toContain(rawName);
  }
  for (const extraRaw of ['read_file', 'web_search', 'web_fetch', 'mail_send', 'tmeetMeetingList', 'fooBar']) {
    expect(fullText).not.toContain(extraRaw);
  }

  for (const element of root.querySelectorAll<HTMLElement>('*')) {
    const title = element.getAttribute('title') ?? '';
    const ariaLabel = element.getAttribute('aria-label') ?? '';
    for (const attr of [title, ariaLabel]) {
      const cleaned = language === 'en' ? attr.replace(/Read and find files/g, '') : attr;
      for (const rawName of FORBIDDEN_RAW_TOOL_NAMES) {
        expect(cleaned).not.toContain(rawName);
      }
      expect(attr).not.toContain('fooBar');
    }
  }

  for (const label of root.querySelectorAll('label')) {
    const labelText = label.textContent?.trim() ?? '';
    for (const rawName of FORBIDDEN_RAW_TOOL_NAMES) {
      expect(labelText).not.toBe(rawName);
    }
  }
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useAppStore.setState({ language: 'zh', developerMode: false });
});

describe('RoleDetailPage normal-mode ability toggles', () => {
  it.each([
    [
      'zh',
      {
        readFiles: '读取和查找文件',
        writeFiles: '写入和编辑文件',
        runCommands: '运行命令',
        searchWeb: '联网搜索',
        openPages: '打开网页',
        remember: '记住和回想',
        mail: '邮件',
        tmeet: '腾讯会议',
        otherTwo: '其他 2 项能力',
        unknownOne: '1 项能力需核对',
      },
    ],
    [
      'en',
      {
        readFiles: 'Read and find files',
        writeFiles: 'Write and edit files',
        runCommands: 'Run commands',
        searchWeb: 'Search the web',
        openPages: 'Open web pages',
        remember: 'Remember and recall',
        mail: 'Mail',
        tmeet: 'Tencent Meeting',
        otherTwo: '2 other abilities',
        unknownOne: '1 abilityNeeds checking',
      },
    ],
  ] as const)(
    '%s shows plain-language abilities, hides internal tool names, and saves registry/connector spellings cleanly',
    async (language, expected) => {
      useAppStore.setState({ language, developerMode: false });
      invokeDomain.mockImplementation((_domain: string, action: string) =>
        Promise.resolve(action === 'detail' ? makeDetail() : []),
      );

      render(<RoleDetailPage roleId="牧之" />);
      fireEvent.click(await screen.findByTestId('role-detail-tab-skills'));
      const editor = await screen.findByTestId('role-equipment-editor');

      // Normal mode hides the raw per-tool checklist and exposes zero internal tool names.
      expect(screen.queryByTestId('role-raw-tools')).toBeNull();
      assertNoInternalToolNamesInNormalView(editor, language);

      // Grouped ability checkboxes: checked when draft contains any spelling, unchecked otherwise.
      const readCheckbox = within(editor).getByLabelText(expected.readFiles) as HTMLInputElement;
      const writeCheckbox = within(editor).getByLabelText(expected.writeFiles) as HTMLInputElement;
      const runCheckbox = within(editor).getByLabelText(expected.runCommands) as HTMLInputElement;
      const searchCheckbox = within(editor).getByLabelText(expected.searchWeb) as HTMLInputElement;
      const openPagesCheckbox = within(editor).getByLabelText(expected.openPages) as HTMLInputElement;
      const rememberCheckbox = within(editor).getByLabelText(expected.remember) as HTMLInputElement;
      const mailCheckbox = within(editor).getByLabelText(expected.mail) as HTMLInputElement;
      const tmeetCheckbox = within(editor).getByLabelText(expected.tmeet) as HTMLInputElement;

      expect(readCheckbox.checked).toBe(true);
      expect(rememberCheckbox.checked).toBe(true);
      expect(writeCheckbox.checked).toBe(false);
      expect(runCheckbox.checked).toBe(false);
      expect(searchCheckbox.checked).toBe(false);
      expect(openPagesCheckbox.checked).toBe(false);
      expect(mailCheckbox.checked).toBe(false);
      expect(tmeetCheckbox.checked).toBe(false);

      // Enabled unmapped tools fall back to the read-only other abilities line.
      expect(screen.getByTestId('role-other-abilities').textContent).toBe(expected.otherTwo);

      // Unknown tools (not in availableTools) show only count + badge, never raw names or checkboxes.
      const unknownNotice = screen.getByTestId('role-unknown-tools');
      expect(unknownNotice.textContent).toBe(expected.unknownOne);
      expect(unknownNotice.querySelector('input')).toBeNull();

      // Untick Read and find files -> removes all spellings (read_file AND Glob).
      fireEvent.click(readCheckbox);
      expect(readCheckbox.checked).toBe(false);

      // Tick Search the web -> adds registry spelling only (WebSearch, not web_search).
      fireEvent.click(searchCheckbox);
      expect(searchCheckbox.checked).toBe(true);

      // Tick Mail connector -> adds all connector tool names (mail, mail_draft, mail_send).
      fireEvent.click(mailCheckbox);
      expect(mailCheckbox.checked).toBe(true);

      // Save and verify exact payload shape and preserved tools.
      fireEvent.click(screen.getByTestId('role-equipment-save'));
      await waitFor(() => {
        expect(invokeDomain).toHaveBeenCalledWith(
          IPC_DOMAINS.ROLES,
          'updateEquipment',
          expect.objectContaining({
            roleId: '牧之',
            equipment: {
              skills: ['research'],
              tools: [
                'MemoryRead',
                'AgentMessage',
                'TaskManager',
                'fooBar',
                'fooBar',
                'WebSearch',
                'mail',
                'mail_draft',
                'mail_send',
              ],
              maxIterations: 20,
              model: 'balanced',
              modelOverride: { provider: 'anthropic', model: 'claude-sonnet' },
            },
          }),
        );
      });
    },
  );

  it.each([
    ['zh', '其他 1 项能力', '2 项能力需核对'],
    ['en', '1 other ability', '2 abilitiesNeeds checking'],
  ] as const)(
    '%s formats singular other-ability and plural unknown-ability counts',
    async (language, expectedOther, expectedUnknown) => {
      useAppStore.setState({ language, developerMode: false });
      invokeDomain.mockImplementation((_domain: string, action: string) =>
        Promise.resolve(
          action === 'detail'
            ? makeDetail({
                tools: ['TaskManager', 'unknownAlpha', 'unknownBeta'],
                availableTools: ['Read', 'TaskManager'],
              })
            : [],
        ),
      );

      render(<RoleDetailPage roleId="牧之" />);
      fireEvent.click(await screen.findByTestId('role-detail-tab-skills'));
      const editor = await screen.findByTestId('role-equipment-editor');

      expect(screen.getByTestId('role-other-abilities').textContent).toBe(expectedOther);
      expect(screen.getByTestId('role-unknown-tools').textContent).toBe(expectedUnknown);
      expect(editor.textContent).not.toContain('TaskManager');
      expect(editor.textContent).not.toContain('unknownAlpha');
      expect(editor.textContent).not.toContain('unknownBeta');
    },
  );
});

describe('RolePackShelf discovery card tools line', () => {
  const packItem: RolePackListItem = {
    entry: {
      roleId: '云端产品顾问',
      displayName: '云端产品顾问',
      description: '云端下发的产品专家',
      agentMd: '---\nname: 云端产品顾问\ntools: [Read, Write, MemoryRead, TaskManager]\n---\nPrompt',
      visual: {
        icon: 'ClipboardList',
        category: 'product',
        displayName: '云端产品顾问',
        profession: '产品顾问',
        tags: ['调研'],
        quickPrompts: [],
      },
      skills: [{ registryName: 'market-research' }],
      packVersion: '1.2.0',
      publisher: 'Neo',
      reviewedAt: '2026-07-23',
      tags: ['调研'],
    },
    tools: ['Read', 'Write', 'MemoryRead', 'TaskManager'],
    installed: false,
    hasUpdate: false,
  };

  it.each([
    ['zh', '工具: 读取和查找文件、写入和编辑文件、记住和回想、其他 1 项能力'],
    ['en', 'Tools: Read and find files, Write and edit files, Remember and recall, 1 other ability'],
  ] as const)('%s renders plain-language ability labels instead of raw tool names', (language, expectedLine) => {
    useAppStore.setState({ language });
    render(
      <RolePackShelf
        items={[packItem]}
        loading={false}
        error={false}
        busyRoleId={null}
        onRetryLoad={() => {}}
        onInstall={() => {}}
        onUninstall={() => {}}
        onRetryMissingSkills={() => {}}
      />,
    );

    const toolsLine = screen.getByTestId('role-pack-tools-云端产品顾问');
    expect(toolsLine.textContent).toBe(expectedLine);
    const cleaned = language === 'en'
      ? (toolsLine.textContent ?? '').replace(/Read and find files|Write and edit files/g, '')
      : (toolsLine.textContent ?? '');
    for (const rawName of ['Read', 'Write', 'MemoryRead', 'TaskManager']) {
      expect(cleaned).not.toContain(rawName);
    }
  });
});

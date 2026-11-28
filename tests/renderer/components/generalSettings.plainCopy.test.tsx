// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS, IPC_DOMAINS } from '../../../src/shared/ipc';
import { OS_SANDBOX_DOCTOR_ITEM_NAME } from '../../../src/shared/constants/sandbox';
import { GeneralSettings } from '../../../src/renderer/components/features/settings/tabs/GeneralSettings';
import { en } from '../../../src/renderer/i18n/en';
import { zh } from '../../../src/renderer/i18n/zh';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useAuthStore } from '../../../src/renderer/stores/authStore';
import { useDoctorStore } from '../../../src/renderer/stores/doctorStore';
import type { DoctorItem } from '../../../src/renderer/types/doctor';

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: vi.fn(async (channel: string) => channel === IPC_CHANNELS.PERMISSION_GET_MODE ? 'default' : undefined),
    invokeDomain: vi.fn(async (domain: string, action: string) => {
      if (domain === IPC_DOMAINS.SETTINGS && action === 'get') {
        return { permissions: { _legacyPermissions: true, deny: ['Write(/etc/*)'] } };
      }
      return undefined;
    }),
  },
}));

const copy = { zh: zh.settings.general.permissions, en: en.settings.general.permissions };
const diagnosticItems = {
  available: {
    status: 'pass',
    message: 'available · seatbelt',
    details: 'Writes are confined to the workspace, TMPDIR.\nrollout: default, acceptEdits',
  },
  disabled: {
    status: 'warn',
    message: 'disabled by OS_SANDBOX_ENABLED=false',
    suggestion: 'Unset OS_SANDBOX_ENABLED to restore the default-on OS sandbox.',
  },
  unavailable: {
    status: 'warn',
    message: 'unavailable · darwin',
    suggestion: 'sandbox-exec unavailable; Bash in default/acceptEdits runs without the OS sandbox.',
  },
} satisfies Record<string, Pick<DoctorItem, 'status' | 'message' | 'details' | 'suggestion'>>;

function renderedCopy(container: HTMLElement) {
  const page = container.cloneNode(true) as HTMLElement;
  page.querySelectorAll('code').forEach((example) => example.remove());
  page.querySelectorAll('textarea').forEach((textarea) => textarea.removeAttribute('placeholder'));
  const attributes = Array.from(page.querySelectorAll('[title], [aria-label], [placeholder]'), (element) =>
    ['title', 'aria-label', 'placeholder'].map((name) => element.getAttribute(name)).join('\n'),
  );
  return [page.textContent, ...attributes].join('\n');
}

async function renderPermissions(language: keyof typeof copy) {
  useAppStore.setState({ language });
  const page = render(<GeneralSettings />);
  await screen.findByText(copy[language].permissionModes.bypassPermissions.title);
  return page;
}

beforeEach(() => {
  useAuthStore.setState({ user: { id: 'test-admin', email: 'admin@test.dev', isAdmin: true } });
  useDoctorStore.setState({ report: null });
});

afterEach(cleanup);

describe.each(['zh', 'en'] as const)('Permissions & Safety copy (%s)', (language) => {
  it.each(Object.entries(diagnosticItems))('renders the %s sandbox pack copy', async (state, diagnostic) => {
    useDoctorStore.setState({
      report: {
        timestamp: 0,
        durationMs: 0,
        items: [{ category: 'environment', name: OS_SANDBOX_DOCTOR_ITEM_NAME, ...diagnostic }],
        summary: { pass: Number(diagnostic.status === 'pass'), warn: Number(diagnostic.status === 'warn'), fail: 0, skip: 0 },
      },
    });
    const { container } = await renderPermissions(language);
    const sandbox = copy[language].sandbox[state as keyof typeof diagnosticItems];
    expect(screen.getByTestId('os-sandbox-settings-hint').textContent).toBe(sandbox.hint);
    expect(screen.getByText(sandbox.description)).toBeTruthy();

    if (language === 'zh') {
      const text = renderedCopy(container);
      expect(text.match(/Writes are confined|TMPDIR|rollout|acceptEdits|OS_SANDBOX_ENABLED|grandfathering|\be2e\b|\bCLI\b|topology|Tool\(glob\)|plan → coder|release notes|\b(?:deny|ask|allow)\b/gi)).toBeNull();
      for (const label of Object.values(copy.zh.userRules.kindLabels)) {
        expect(screen.getByText(label, { selector: 'div' })).toBeTruthy();
      }
      expect(screen.getByText(copy.zh.highestPriorityPrefix + '禁止')).toBeTruthy();
    }
  });

  it('uses the on copy before a diagnostic report arrives', async () => {
    await renderPermissions(language);
    expect(screen.getByTestId('os-sandbox-settings-hint').textContent).toBe(copy[language].sandbox.available.hint);
  });
});

it('preserves existing English permission strings outside the sandbox', () => {
  const { sandbox, userRules, ...permissions } = copy.en;
  const { kindLabels, savedKindLabels, ...existingUserRules } = userRules;
  // The snapshot was checked against the permission strings on origin/main.
  expect({ ...permissions, userRules: existingUserRules }).toMatchSnapshot();
  expect(kindLabels).toEqual({ deny: 'Deny', ask: 'Ask', allow: 'Allow' });
  expect(savedKindLabels).toEqual({ deny: 'deny', ask: 'ask', allow: 'allow' });
  expect(sandbox.title).toBe('OS sandbox');
});

it('states the consequences of Full access and Independent mode before a choice', async () => {
  await renderPermissions('zh');
  const { permissionModes, inheritanceModes, bypassWarning, switchAction } = copy.zh;
  const fullAccess = screen.getByText(permissionModes.bypassPermissions.title).closest('tr')!;
  const independent = screen.getByText(inheritanceModes.independent.title).closest('tr')!;

  expect(within(fullAccess).getByText(permissionModes.bypassPermissions.description).textContent)
    .toMatch(/不再先问你.*工作文件夹以外/);
  expect(within(independent).getByText(inheritanceModes.independent.description).textContent)
    .toMatch(/不用问你.*比主对话更宽/);
  expect(within(independent).getByText(inheritanceModes.independent.warning).textContent)
    .toContain('不经你确认就修改文件或运行命令');

  fireEvent.click(within(fullAccess).getByRole('button', { name: switchAction }));
  const dialog = within(screen.getByRole('dialog'));
  expect(dialog.getByText(bypassWarning.description).textContent).toMatch(/跳过所有确认.*工作文件夹以外/);
});

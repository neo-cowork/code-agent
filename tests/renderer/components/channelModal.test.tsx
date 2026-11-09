// @vitest-environment jsdom
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChannelModal } from '../../../src/renderer/components/features/settings/tabs/ChannelsSettings';
import { en } from '../../../src/renderer/i18n/en';
import { zh } from '../../../src/renderer/i18n/zh';
import { useAppStore } from '../../../src/renderer/stores/appStore';

const channelsText = zh.settings.channels;
const enChannelsText = en.settings.channels;

const ZH_ALLOWLIST = '群里需 @ 才回应（默认）';
const ZH_ALL_MEMBERS = '群里所有消息都回应（访客身份）';
const ZH_HINT = '访客只能用只读工具；哪些人算信任用户，在上面的「白名单用户 ID」里单独设置';
const ZH_PREREQUISITE = '需要先在 Telegram 里关闭机器人的隐私模式，连接后这里会告诉你是否已生效。';
const EN_ALLOWLIST = 'Reply only when @-mentioned in groups (default)';
const EN_ALL_MEMBERS = 'Reply to every group message (as guest)';
const EN_HINT = 'Guests only get read-only tools. Who counts as trusted is set separately in the allowlisted user IDs field above.';

afterEach(() => {
  cleanup();
  useAppStore.setState({ language: 'zh' });
});

const channelTypes = [
  { type: 'http-api' as const, name: 'HTTP API' },
  { type: 'feishu' as const, name: '飞书' },
  { type: 'lark' as const, name: 'Lark' },
  { type: 'telegram' as const, name: 'Telegram' },
];

describe('ChannelModal required-field validation', () => {
  for (const [language, locale] of [['zh', zh], ['en', en]] as const) {
    for (const [type, errorKeys] of [
      ['http-api', ['nameRequiredError']],
      ['feishu', ['nameRequiredError', 'appIdRequiredError', 'appCredentialRequiredError']],
      ['lark', ['nameRequiredError', 'appIdRequiredError', 'appCredentialRequiredError']],
      ['telegram', ['nameRequiredError', 'botTokenRequiredError']],
    ] as const) {
      it(`${language} ${type}: empty submit stays inline and localized`, () => {
        useAppStore.setState({ language });
        const onSave = vi.fn();
        render(<ChannelModal channelTypes={channelTypes} onSave={onSave} onClose={() => {}} />);
        const form = screen.getByRole('dialog').querySelector('form') as HTMLFormElement;

        expect(form.noValidate).toBe(true);
        expect(form.querySelector('[required]')).toBeNull();
        fireEvent.change(screen.getAllByRole('combobox')[0]!, { target: { value: type } });
        fireEvent.submit(form);

        expect(onSave).not.toHaveBeenCalled();
        for (const errorKey of errorKeys) {
          expect(screen.getByText(locale.settings.channels.modal[errorKey])).toBeTruthy();
        }
      });
    }
  }

  it('trims whitespace, focuses the first missing field, and clears its error while typing', () => {
    const onSave = vi.fn();
    render(<ChannelModal channelTypes={channelTypes} onSave={onSave} onClose={() => {}} />);
    const form = screen.getByRole('dialog').querySelector('form') as HTMLFormElement;
    const name = screen.getByPlaceholderText(channelsText.modal.namePlaceholder);

    fireEvent.change(name, { target: { value: '   ' } });
    fireEvent.submit(form);
    expect(document.activeElement).toBe(name);
    expect(screen.getByText(channelsText.modal.nameRequiredError)).toBeTruthy();

    fireEvent.change(name, { target: { value: 'HTTP API' } });
    expect(screen.queryByText(channelsText.modal.nameRequiredError)).toBeNull();
  });

  it.each([
    ['feishu', 'cli_xxxxxxxxxx', 'appIdRequiredError'],
    ['lark', 'cli_xxxxxxxxxx', 'appIdRequiredError'],
    ['telegram', channelsText.modal.botTokenPlaceholder, 'botTokenRequiredError'],
  ] as const)('focuses the first missing field for %s', (type, placeholder, errorKey) => {
    const onSave = vi.fn();
    render(<ChannelModal channelTypes={channelTypes} onSave={onSave} onClose={() => {}} />);
    const form = screen.getByRole('dialog').querySelector('form') as HTMLFormElement;
    fireEvent.change(screen.getAllByRole('combobox')[0]!, { target: { value: type } });
    fireEvent.change(screen.getByPlaceholderText(channelsText.modal.namePlaceholder), { target: { value: 'acct' } });
    const firstMissing = screen.getByPlaceholderText(placeholder);
    fireEvent.change(firstMissing, { target: { value: '   ' } });
    fireEvent.submit(form);

    expect(document.activeElement).toBe(firstMissing);
    expect(screen.getByText(channelsText.modal[errorKey])).toBeTruthy();
    fireEvent.change(firstMissing, { target: { value: 'credential' } });
    expect(screen.queryByText(channelsText.modal[errorKey])).toBeNull();
  });

  it.each([
    {
      type: 'http-api',
      config: { type: 'http-api', port: 8080, apiKey: 'test-key', enableCors: true, privacyMode: 'local-redact' },
    },
    ...(['feishu', 'lark'] as const).map((type) => ({
      type,
      config: {
        type,
        appId: 'cli_x',
        appSecret: 'secret',
        encryptKey: undefined,
        verificationToken: undefined,
        useWebSocket: true,
        webhookPort: 3200,
        outboundAllowlist: [],
        inboundAllowlist: undefined,
        ownerOpenId: undefined,
        privacyMode: 'local-redact',
      },
    })),
    {
      type: 'telegram',
      config: {
        type: 'telegram',
        botToken: '123:abc',
        proxyUrl: undefined,
        fallbackProxyUrl: undefined,
        allowedUserIds: undefined,
        groupAccessMode: 'allowlist',
        privacyMode: 'local-redact',
      },
    },
  ] as const)('submits the complete validated config for $type', ({ type, config }) => {
    const onSave = vi.fn();
    render(<ChannelModal channelTypes={channelTypes} onSave={onSave} onClose={() => {}} />);
    fireEvent.change(screen.getAllByRole('combobox')[0]!, { target: { value: type } });
    fireEvent.change(screen.getByPlaceholderText(channelsText.modal.namePlaceholder), { target: { value: 'acct' } });
    if (type === 'http-api') {
      fireEvent.change(screen.getByPlaceholderText(channelsText.modal.apiKeyPlaceholder), { target: { value: 'test-key' } });
    } else if (type === 'feishu' || type === 'lark') {
      fireEvent.change(screen.getByPlaceholderText('cli_xxxxxxxxxx'), { target: { value: 'cli_x' } });
      fireEvent.change(screen.getByRole('dialog').querySelector('input[type="password"]')!, { target: { value: 'secret' } });
    } else {
      fireEvent.change(screen.getByPlaceholderText(channelsText.modal.botTokenPlaceholder), { target: { value: '123:abc' } });
    }
    fireEvent.submit(screen.getByRole('dialog').querySelector('form')!);

    expect(onSave).toHaveBeenCalledWith({ name: 'acct', type, config });
  });
});

// 验证 ChannelModal 从手搓 fixed-inset-0 表单弹窗迁移到 Modal primitive 后行为不回归
describe('ChannelModal (Modal primitive 迁移验证)', () => {
  it('新增态：走 Modal primitive（role=dialog + aria-modal），标题/字段/footer 齐全', () => {
    const html = renderToStaticMarkup(
      <ChannelModal channelTypes={[]} onSave={() => {}} onClose={() => {}} />
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    // 标题由 Modal header 渲染
    expect(html).toContain(channelsText.modal.addTitle);
    // 表单字段保留
    expect(html).toContain(channelsText.modal.nameLabel);
    expect(html).toContain(channelsText.modal.privacyModeLabel);
    // footer 走 Button primitive
    expect(html).toContain(channelsText.actions.cancel);
    expect(html).toContain(channelsText.actions.add);
  });

  it('新建飞书账号默认启用长连接，并提交出站白名单', () => {
    const onSave = vi.fn();
    render(
      <ChannelModal
        channelTypes={[{ type: 'feishu', name: '飞书' }]}
        onSave={onSave}
        onClose={() => {}}
      />
    );

    fireEvent.change(screen.getAllByRole('combobox')[0]!, { target: { value: 'feishu' } });
    fireEvent.change(screen.getByPlaceholderText(channelsText.modal.namePlaceholder), {
      target: { value: 'Feishu' },
    });
    fireEvent.change(screen.getByPlaceholderText('cli_xxxxxxxxxx'), { target: { value: 'cli_x' } });
    fireEvent.change(screen.getByRole('dialog').querySelector('input[type="password"]')!, { target: { value: 'secret' } });
    const longConnection = screen.getByRole('checkbox', { name: channelsText.modal.webSocketLabel });
    expect((longConnection as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(channelsText.modal.outboundTargetsHint)).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText(channelsText.modal.outboundTargetsPlaceholder), {
      target: { value: 'oc_one, oc_two' },
    });
    fireEvent.submit(screen.getByRole('dialog').querySelector('form')!);

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      type: 'feishu',
      config: expect.objectContaining({
        useWebSocket: true,
        outboundAllowlist: ['oc_one', 'oc_two'],
      }),
    }));
  });

  it('新建 Telegram 账号默认白名单档，切全体成员档后提交 groupAccessMode（N-TELEGRAM-GROUPMODE-UI）', () => {
    const onSave = vi.fn();
    render(
      <ChannelModal
        channelTypes={[{ type: 'telegram', name: 'Telegram' }]}
        onSave={onSave}
        onClose={() => {}}
      />
    );

    fireEvent.change(screen.getAllByRole('combobox')[0]!, { target: { value: 'telegram' } });
    const modeSelect = screen.getByRole('combobox', { name: channelsText.modal.groupAccessModeLabel });
    expect((modeSelect as HTMLSelectElement).value).toBe('allowlist');
    expect(screen.getByRole('option', { name: ZH_ALLOWLIST })).toBeTruthy();
    expect(screen.getByRole('option', { name: ZH_ALL_MEMBERS })).toBeTruthy();
    expect(screen.getByText(ZH_HINT)).toBeTruthy();
    expect(screen.queryByText(ZH_PREREQUISITE)).toBeNull();

    fireEvent.change(modeSelect, { target: { value: 'all_members' } });
    expect(screen.getByText(ZH_PREREQUISITE)).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText(channelsText.modal.namePlaceholder), {
      target: { value: 'Telegram' },
    });
    fireEvent.change(screen.getByPlaceholderText(channelsText.modal.botTokenPlaceholder), {
      target: { value: '123:abc' },
    });
    fireEvent.submit(screen.getByRole('dialog').querySelector('form')!);

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      type: 'telegram',
      config: expect.objectContaining({ groupAccessMode: 'all_members' }),
    }));
  });

  it('编辑 Telegram 账号时回显已保存的群准入档', () => {
    render(
      <ChannelModal
        account={{
          id: 'tg-1',
          name: 'TG',
          type: 'telegram',
          status: 'connected',
          enabled: true,
          createdAt: 1,
          config: { type: 'telegram', botToken: '123:abc', groupAccessMode: 'all_members' },
        }}
        channelTypes={[{ type: 'telegram', name: 'Telegram' }]}
        onSave={() => {}}
        onClose={() => {}}
      />
    );

    const modeSelect = screen.getByRole('combobox', { name: channelsText.modal.groupAccessModeLabel });
    expect((modeSelect as HTMLSelectElement).value).toBe('all_members');
    expect(screen.getByText(ZH_PREREQUISITE)).toBeTruthy();

    fireEvent.change(modeSelect, { target: { value: 'allowlist' } });
    expect(screen.queryByText(ZH_PREREQUISITE)).toBeNull();
  });

  it('群准入两档的中英文案按行为命名，说明写明白名单是另一项设置', () => {
    expect(channelsText.modal.groupAccessModeAllowlist).toBe(ZH_ALLOWLIST);
    expect(channelsText.modal.groupAccessModeAllMembers).toBe(ZH_ALL_MEMBERS);
    expect(channelsText.modal.groupAccessModeHint).toBe(ZH_HINT);
    expect(channelsText.modal.groupAccessModePrivacyPrerequisite).toBe(ZH_PREREQUISITE);
    expect(enChannelsText.modal.groupAccessModeAllowlist).toBe(EN_ALLOWLIST);
    expect(enChannelsText.modal.groupAccessModeAllMembers).toBe(EN_ALL_MEMBERS);
    expect(enChannelsText.modal.groupAccessModeHint).toBe(EN_HINT);
    for (const warning of [
      channelsText.modal.telegramPrivacyModeWarning,
      enChannelsText.modal.telegramPrivacyModeWarning,
    ]) {
      expect(warning).toContain('/setprivacy');
      expect(warning).toContain('Disable');
    }
    expect(channelsText.modal.telegramPrivacyModeWarning).toContain('移出群');
    expect(channelsText.modal.telegramPrivacyModeWarning).toContain('重新拉进来');
    expect(channelsText.modal.telegramPrivacyModeWarning).toContain('断开再连接');
    expect(channelsText.modal.telegramPrivacyModeWarning).toContain('群管理员');
    expect(enChannelsText.modal.telegramPrivacyModeWarning).toContain('Remove the bot from the group and add it back');
    expect(enChannelsText.modal.telegramPrivacyModeWarning).toContain('disconnect and connect here to re-check');
    expect(enChannelsText.modal.telegramPrivacyModeWarning).toContain('group admin');
  });
});

describe('ChannelModal 按钮固定在 Modal footer（N-CHANNEL-MODAL-ADD-BUTTON-REACHABLE）', () => {
  const editAccounts = {
    'http-api': { type: 'http-api', apiKey: 'k' },
    feishu: { type: 'feishu', appId: 'cli_x', appSecret: 's' },
    telegram: { type: 'telegram', botToken: '123:abc' },
  } as const;
  const fillAdd = (type: 'http-api' | 'feishu' | 'telegram') => {
    fireEvent.change(screen.getAllByRole('combobox')[0]!, { target: { value: type } });
    fireEvent.change(screen.getByPlaceholderText(channelsText.modal.namePlaceholder), {
      target: { value: 'acct' },
    });
    if (type === 'feishu') {
      fireEvent.change(screen.getByPlaceholderText('cli_xxxxxxxxxx'), { target: { value: 'cli_x' } });
      fireEvent.change(screen.getByRole('dialog').querySelector('input[type="password"]')!, { target: { value: 's' } });
    }
    if (type === 'telegram') {
      fireEvent.change(screen.getByPlaceholderText(channelsText.modal.botTokenPlaceholder), { target: { value: '123:abc' } });
    }
  };
  const expectPinned = (label: string) => {
    const dialog = screen.getByRole('dialog');
    const submit = screen.getByRole('button', { name: label });
    expect(submit.getAttribute('type')).toBe('submit');
    expect(dialog.contains(submit)).toBe(true);
    expect(submit.closest('form')).toBeNull();
    expect(submit.closest('[class*="overflow-y-auto"]')).toBeNull();
    return submit;
  };

  for (const type of ['http-api', 'feishu', 'telegram'] as const) {
    it(`新增态 ${type}：提交按钮在 dialog 内、form 外、滚动区外，点击触发 onSave 一次`, () => {
      const onSave = vi.fn();
      render(
        <ChannelModal
          channelTypes={[{ type, name: type }]}
          onSave={onSave}
          onClose={() => {}}
        />
      );
      fillAdd(type);
      const submit = expectPinned(channelsText.actions.add);
      fireEvent.click(submit);
      expect(onSave).toHaveBeenCalledTimes(1);
    });

    it(`编辑态 ${type}：保存按钮在 dialog 内、form 外、滚动区外，点击触发 onSave 一次`, () => {
      const onSave = vi.fn();
      render(
        <ChannelModal
          account={{
            id: 'a-1',
            name: 'acct',
            type,
            status: 'connected',
            enabled: true,
            createdAt: 1,
            config: editAccounts[type] as never,
          }}
          channelTypes={[{ type, name: type }]}
          onSave={onSave}
          onClose={() => {}}
        />
      );
      const submit = expectPinned(channelsText.actions.save);
      fireEvent.click(submit);
      expect(onSave).toHaveBeenCalledTimes(1);
    });
  }

  it('名称框回车（表单提交）同样触发 onSave 一次', () => {
    const onSave = vi.fn();
    render(<ChannelModal channelTypes={[{ type: 'http-api', name: 'h' }]} onSave={onSave} onClose={() => {}} />);
    fillAdd('http-api');
    fireEvent.submit(screen.getByPlaceholderText(channelsText.modal.namePlaceholder).closest('form')!);
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});

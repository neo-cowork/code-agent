// ============================================================================
// PermissionGrantList — 「你授权过的权限」统一列表（N-PERM-GRANT-LEDGER）
// ============================================================================
// 后端 IPC: domain:settings
//   actions: listPermissionGrants / revokePermissionGrant {id}
// 三个存档（按应用 / automation 长期授权 / 会话内放行）折成的归一台账（host 侧
// grantLedger.ts）。每行可撤销；撤销后下一次同类操作会重新询问。agent 侧没有任何
// 工具能列出或撤销这里的内容（no-self-revoke，见 tests/unit/permissions/grantLedger.test.ts）。
// ============================================================================

import React, { useCallback, useEffect, useState } from 'react';
import { IPC_DOMAINS } from '@shared/ipc';
import type { PermissionGrantEntry } from '@shared/contract';
import ipcService from '../../../../services/ipcService';
import { SettingsSection } from '../SettingsLayout';
import { useI18n } from '../../../../hooks/useI18n';
import { formatDateTime } from '../../../../utils/formatDateTime';
import { getHumanToolLabel } from '../../../../utils/toolHumanLabel';
import { zh } from '../../../../i18n/zh';
import { Button } from '../../../primitives';

type PermissionGrantsText = typeof zh.settings.privacy.permissionGrants;

// 授权列表里的核心文件/命令工具没有连接器身份，这里单独映射；不放进共享 getHumanToolLabel，
// 否则聊天里的审批记录（ToolStepGroup）会出现「运行命令 · 运行了命令 ls」式重复前缀。
const GRANT_TOOL_LABEL_KEYS: Record<string, keyof typeof zh.receiptPresentation.humanToolLabels.tools> = {
  bash: 'runCommand',
  write: 'writeFile',
  writefile: 'writeFile',
  edit: 'editFile',
  editfile: 'editFile',
};

function toolGrantLabel(
  label: string,
  labels: typeof zh.receiptPresentation.humanToolLabels,
): string {
  const key = GRANT_TOOL_LABEL_KEYS[label.trim().toLowerCase().replace(/[-_\s]/g, '')];
  return key ? labels.tools[key] : getHumanToolLabel({ toolName: label, labels });
}

function scopeLabel(source: string, copy: PermissionGrantsText['scope']): string {
  if (source === 'conversation') return copy.conversation;
  if (source === 'settings') return copy.always;
  if (source === 'run') return copy.run;
  if (source === '24h') return copy.hours24;
  return copy.automation.replace('{title}', source);
}

function kindLabel(kind: PermissionGrantEntry['kind'], copy: PermissionGrantsText['kind']): string {
  if (kind === 'app') return copy.app;
  if (kind === 'tool-target') return copy.toolTarget;
  if (kind === 'tool-timed') return copy.toolTimed;
  return copy.toolSession;
}

function remainingTime(expiresAt: number, copy: PermissionGrantsText): string {
  const minutes = Math.max(1, (expiresAt - Date.now()) / 60_000);
  return minutes < 60
    ? copy.remainingMinutes.replace('{n}', String(Math.ceil(minutes)))
    : copy.remainingHours.replace('{n}', String(Math.ceil(minutes / 60)));
}

const PermissionGrantList: React.FC = () => {
  const { t, language } = useI18n();
  const copy = t.settings.privacy.permissionGrants;
  const [grants, setGrants] = useState<PermissionGrantEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await ipcService.invokeDomain<PermissionGrantEntry[]>(
          IPC_DOMAINS.SETTINGS,
          'listPermissionGrants',
        );
        if (!cancelled && Array.isArray(rows)) setGrants(rows);
      } catch {
        // 列表拉不下来就当作没有授权；撤销动作仍会走真后端。
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleRevoke = useCallback(async (id: string) => {
    try {
      const result = await ipcService.invokeDomain<{ revoked: boolean }>(
        IPC_DOMAINS.SETTINGS,
        'revokePermissionGrant',
        { id },
      );
      if (result?.revoked) setGrants((rows) => rows.filter((row) => row.id !== id));
    } catch {
      // 撤销没落地就留着这一行。
    }
  }, []);

  return (
    <SettingsSection
      title={copy.title}
      description={copy.description}
    >
      {grants.length === 0 ? (
        <p className="text-xs text-zinc-500">{copy.empty}</p>
      ) : (
        <ul className="divide-y divide-zinc-800">
          {grants.map((grant) => (
            <li key={grant.id} data-testid="permission-grant-row" className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <div className="truncate text-sm text-zinc-200">
                  {grant.kind === 'app' ? grant.label : toolGrantLabel(grant.label, t.receiptPresentation.humanToolLabels)}
                </div>
                <div className="mt-0.5 text-xs text-zinc-500">
                  {kindLabel(grant.kind, copy.kind)}
                  {' · '}
                  {scopeLabel(grant.source, copy.scope)}
                  {' · '}
                  {copy.grantedOn.replace('{date}', formatDateTime(grant.grantedAt, language))}
                  {grant.expiresAt !== null ? ` · ${grant.kind === 'tool-timed'
                    ? remainingTime(grant.expiresAt, copy)
                    : copy.expiresOn.replace('{date}', formatDateTime(grant.expiresAt, language))}` : ''}
                </div>
                {(grant.kind === 'tool-target' || grant.kind === 'tool-timed') && grant.detail ? (
                  <div className="mt-0.5 truncate text-xs text-zinc-400">{copy.targetLabel.replace('{target}', grant.detail)}</div>
                ) : null}
              </div>
              <Button
                variant="secondary"
                size="sm"
                type="button"
                data-testid="permission-grant-revoke"
                onClick={() => { void handleRevoke(grant.id); }}
              >
                {copy.revoke}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </SettingsSection>
  );
};

export default PermissionGrantList;

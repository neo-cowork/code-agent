import { describe, expect, it } from 'vitest';
import type { ComputerSurfaceState } from '../../../src/renderer/services/nativeDesktop';
import { localOpsEn, localOpsZh } from '../../../src/renderer/i18n/localOps';
import {
  buildComputerUseTargets,
  buildRecentComputerUseAction,
  describeComputerUseFailures,
} from '../../../src/renderer/utils/computerUseWorkbench';

function makeSurface(overrides: Partial<ComputerSurfaceState> = {}): ComputerSurfaceState {
  return {
    id: 'surface-1',
    mode: 'foreground_fallback',
    platform: 'darwin',
    ready: true,
    background: false,
    requiresForeground: true,
    approvalScope: 'session_app',
    safetyNote: 'Foreground fallback',
    targetApp: 'Safari',
    approvedApps: [],
    deniedApps: [],
    lastAction: null,
    ...overrides,
  };
}

describe('computerUseWorkbench', () => {
  it('builds app and window candidates from frontmost, surface, and recent activity', () => {
    const targets = buildComputerUseTargets({
      frontmost: {
        platform: 'darwin',
        capturedAtMs: 1000,
        appName: 'Safari',
        bundleId: 'com.apple.Safari',
        windowTitle: 'Docs',
      },
      surface: makeSurface({
        targetApp: 'Preview',
        lastSnapshot: {
          capturedAtMs: 900,
          appName: 'Preview',
          windowTitle: 'Design.pdf',
        },
        approvedApps: ['Notes'],
        deniedApps: ['Mail'],
      }),
      recentEvents: [
        {
          id: 'event-1',
          capturedAtMs: 800,
          appName: 'Code',
          windowTitle: 'ComputerUsePanel.tsx',
          fingerprint: 'f1',
        },
      ],
    });

    expect(targets.map((target) => [target.source, target.appName, target.windowTitle])).toEqual([
      ['frontmost', 'Safari', 'Docs'],
      ['surface', 'Preview', 'Design.pdf'],
      ['approved', 'Notes', undefined],
      ['denied', 'Mail', undefined],
      ['recent', 'Code', 'ComputerUsePanel.tsx'],
    ]);
  });

  it('reuses the existing browser/computer action preview for recent action risk summaries', () => {
    const summary = buildRecentComputerUseAction(makeSurface({
      mode: 'background_ax',
      background: true,
      requiresForeground: false,
      targetApp: 'Finder',
      lastAction: {
        id: 'trace-1',
        targetKind: 'computer',
        toolName: 'computer_use',
        action: 'get_ax_elements',
        mode: 'background_ax',
        startedAtMs: 1000,
        completedAtMs: 1100,
        evidenceSummary: ['2 candidates'],
      },
    }));

    expect(summary?.preview).toMatchObject({
      surface: 'computer',
      summary: '读取后台无障碍元素',
      target: 'Finder',
      risk: 'read',
      riskLabel: '只读',
      mode: 'background_ax',
      traceId: 'trace-1',
    });
  });

  it('explains provider, permission, foreground, and AX quality degradation', () => {
    const explanations = describeComputerUseFailures({
      copy: localOpsZh.localOps.computerUse,
      nativeAvailable: false,
      desktopProviderError: 'Computer Surface state unavailable',
      permissions: {
        schemaVersion: 1,
        platform: 'darwin',
        checkedAtMs: 1000,
        bundleId: 'com.linchen.code-agent.dev',
        permissions: [
          {
            kind: 'screenCapture',
            label: 'Screen Recording',
            status: 'denied',
            required: false,
            detail: 'Screen Recording permission not granted.',
          },
          {
            kind: 'accessibility',
            label: 'Accessibility',
            status: 'wrong_bundle_id',
            required: true,
            detail: 'Authorized production bundle only.',
          },
          {
            kind: 'microphone',
            label: 'Microphone',
            status: 'needs_restart',
            required: true,
            detail: 'Restart after grant.',
          },
          { kind: 'notifications', status: 'unknown', required: false, label: 'Notifications' },
        ],
        summary: {
          granted: 0,
          denied: 1,
          needsRestart: 1,
          wrongBundleId: 1,
          unknown: 1,
          unsupported: 0,
        },
      },
      surface: makeSurface({
        failureKind: 'ax_tree_poor',
        axQuality: {
          score: 0.2,
          grade: 'poor',
          elementCount: 4,
          labeledElementCount: 1,
          withAxPathCount: 1,
          unlabeledRatio: 0.75,
          missingAxPathRatio: 0.75,
          duplicateLabelRoleCount: 2,
          roleCounts: { AXGroup: 4 },
          reasons: ['mostly unlabeled elements'],
        },
      }),
      targets: [],
      selectedTargetApp: 'Safari',
      elementsError: 'AX unavailable',
    });

    expect(explanations.map((item) => item.id)).toEqual(expect.arrayContaining([
      'native-runtime-unavailable',
      'desktop-provider-error',
      'screenCapture:denied',
      'accessibility:wrong_bundle_id',
      'automation-per-app',
      'failure:ax_tree_poor',
      'foreground-fallback',
      'ax-quality-poor',
      'elements-error',
      'no-targets',
    ]));
    // 权限名走 i18n：zh 文案是「辅助功能 / 屏幕录制」，不再是英文系统名
    expect(explanations.find((item) => item.id === 'screenCapture:denied')?.title)
      .toContain('屏幕录制');
    expect(explanations.find((item) => item.id === 'accessibility:wrong_bundle_id')?.title)
      .toContain('辅助功能');
    expect(explanations.find((item) => item.id === 'automation-per-app')?.title)
      .toContain('自动化');
    expect(explanations.find((item) => item.id === 'failure:ax_tree_poor')?.detail)
      .toContain('Electron');
    // 默认视图的文案不得带工程词；原始报错只放进「诊断」区
    const visible = explanations.map((item) => `${item.title} ${item.detail}`).join('\n');
    expect(visible).not.toMatch(/provider|axPath|AX candidates|AX tree/i);
    expect(visible).not.toContain('AX unavailable');
    expect(visible).not.toContain('Computer Surface state unavailable');
    // 原生英文 detail 不再上默认卡，一律本地化提示
    expect(visible).not.toContain('Screen Recording permission not granted.');
    expect(visible).not.toContain('Authorized production bundle only.');
    expect(visible).not.toMatch(/Accessibility|Screen Recording|Automation/);
  });

  it('builds every failure card from the passed copy: en output carries no Chinese', () => {
    const explanations = describeComputerUseFailures({
      copy: localOpsEn.localOps.computerUse,
      nativeAvailable: false,
      desktopProviderError: 'Computer Surface state unavailable',
      permissions: null,
      surface: makeSurface({ failureKind: 'permission_denied', blockedReason: 'blocked by host' }),
      targets: [],
      elementsError: 'AX unavailable',
      observeError: 'observe failed',
      screenCaptureOptional: true,
    });

    const visible = explanations.map((item) => `${item.title} ${item.detail}`).join('\n');
    expect(visible).toContain('Screen Recording is optional');
    expect(visible).toContain('Accessibility not probed yet');
    expect(visible).toContain('Automation is granted per app');
    // en 输出不得混入 CJK；zh 权限名（辅助功能/屏幕录制）不得出现在 en 卡上
    expect(visible).not.toMatch(/[㐀-䶿一-鿿豈-﫿]/u);
    expect(visible).not.toContain('辅助功能');
    // 权限状态映射保持：permission_denied 是 blocked 色调
    expect(explanations.find((item) => item.id === 'failure:permission_denied')?.tone).toBe('blocked');
  });
  it.each([
    ['zh', localOpsZh.localOps.computerUse, '辅助功能'],
    ['en', localOpsEn.localOps.computerUse, 'Accessibility'],
  ])('accessibility denied card body says not granted, not unconfirmed (%s)', (_l, copy, name) => {
    const explanations = describeComputerUseFailures({
      copy,
      nativeAvailable: true,
      desktopProviderError: null,
      permissions: {
        schemaVersion: 1,
        platform: 'darwin',
        checkedAtMs: 1000,
        bundleId: 'x',
        permissions: [{
          kind: 'accessibility',
          label: 'Accessibility',
          status: 'denied',
          required: true,
          detail: 'AXIsProcessTrusted() returned false.',
        }],
        summary: { granted: 0, denied: 1, needsRestart: 0, wrongBundleId: 0, unknown: 0, unsupported: 0 },
      },
      surface: makeSurface(),
      targets: [],
      elementsError: null,
      observeError: null,
    });
    const card = explanations.find((item) => item.id === 'accessibility:denied');
    expect(card?.title).toContain(name);
    expect(card?.detail).toContain(name);
    expect(card?.detail).not.toMatch(/未确认|unconfirmed/);
  });
});

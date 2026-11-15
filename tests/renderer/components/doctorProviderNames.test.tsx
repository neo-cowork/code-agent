// @vitest-environment jsdom
// Doctor 连通性项的 name 是 host 写入的注册表默认名（英文）；中文界面要显示原中文名，英文界面无 CJK。
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PROVIDER_REGISTRY } from '../../../src/shared/constants';
import { DoctorSettings } from '../../../src/renderer/components/features/settings/tabs/DoctorSettings';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useDoctorStore } from '../../../src/renderer/stores/doctorStore';
import { useBundledCapabilityStore } from '../../../src/renderer/stores/bundledCapabilityStore';
import type { DoctorReport } from '../../../src/renderer/types/doctor';

const CJK = /[一-鿿]/;
const IDS = Object.keys(PROVIDER_REGISTRY) as Array<keyof typeof PROVIDER_REGISTRY>;
const REPORT: DoctorReport = {
  timestamp: new Date(2026, 10, 9, 16, 5, 0).getTime(),
  durationMs: 1,
  items: IDS.map((id) => ({ category: 'network' as const, name: PROVIDER_REGISTRY[id].displayName, status: 'skip' as const, message: 'x' })),
  summary: { pass: 0, warn: 0, fail: 0, skip: IDS.length },
};

beforeEach(() => {
  useDoctorStore.setState({ report: REPORT, isRunning: false, runningCategory: null, lastError: null, startupCheckDone: true });
  useBundledCapabilityStore.setState({ installed: { 'builtin.voice-live': false, 'builtin.voice-input': false } });
});
afterEach(() => {
  cleanup();
  useDoctorStore.setState({ report: null, isRunning: false, runningCategory: null, lastError: null, startupCheckDone: false });
});

function names(): string[] {
  return Array.from(document.querySelectorAll('span.text-sm.text-zinc-200')).map((el) => el.textContent ?? '');
}

describe('Doctor network item names follow UI language', () => {
  it('zh: xiaomi / volcengine show the original Chinese names', () => {
    useAppStore.setState({ language: 'zh' });
    render(<DoctorSettings />);
    const shown = names();
    expect(shown).toContain('小米 MiMo');
    expect(shown).toContain('火山引擎 (豆包)');
    expect(shown).toContain('Zhipu GLM'); // 改前 zh 就是注册表英文名
  });

  it('en: every built-in provider item is English (no CJK)', () => {
    useAppStore.setState({ language: 'en' });
    render(<DoctorSettings />);
    const shown = names();
    expect(shown).toContain('Xiaomi MiMo');
    expect(shown).toContain('Volcengine (Doubao)');
    expect(shown.length).toBeGreaterThanOrEqual(IDS.length);
    for (const name of shown) expect(name).not.toMatch(CJK);
  });
});

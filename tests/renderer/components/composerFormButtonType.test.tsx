// @vitest-environment jsdom
// composer <form> 子树里的按钮不得缺 type：无 type 的 button 默认是 submit，
// 点它会把 composer 表单一起交出去（发送草稿 / 丢弃待确认定时草案）。
// 行为面取一个代表（CronCloudCreateNotice，经 ScheduleConfirmCard 挂进表单），
// 其余站点用源级检查兜住：本单修过的文件里每个 Button/button 开标签都必须声明 type。
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CronCloudCreateNotice } from '../../../src/renderer/components/features/cron/CronCloudCreateNotice';

afterEach(cleanup);

describe('composer form subtree buttons do not submit the form', () => {
  it('CronCloudCreateNotice buttons inside a <form> fire their onClick and not submit', () => {
    const submit = vi.fn((e: React.FormEvent) => e.preventDefault());
    const onSwitchLocal = vi.fn();
    const onSettings = vi.fn();
    render(
      <form data-testid="composer-form" onSubmit={submit}>
        <CronCloudCreateNotice onSwitchLocal={onSwitchLocal} onSettings={onSettings} />
      </form>
    );
    fireEvent.click(screen.getByRole('button', { name: '改在这台电脑运行' }));
    fireEvent.click(screen.getByRole('button', { name: '去配置云端服务' }));
    expect(onSwitchLocal).toHaveBeenCalledTimes(1);
    expect(onSettings).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled(); // 通知条按钮不是发送键
  });
});

/** 本单补过 type 的 composer 表单子树文件（相对仓库根）。删 type 会回退成隐式 submit。 */
const SWEPT_FILES = [
  'src/renderer/components/features/chat/ChatInput/ComposerRejectedUploadsNotice.tsx',
  'src/renderer/components/features/chat/ChatInput/PermissionToggle.tsx',
  'src/renderer/components/StatusBar/ModelSlot.tsx',
  'src/renderer/components/features/chat/RoleFirstWakeCard.tsx',
  'src/renderer/components/features/cron/CronCloudCreateNotice.tsx',
  'src/renderer/components/features/cron/CronEventScheduleFields.tsx',
  'src/renderer/components/features/cron/CronMailEventFields.tsx',
];

/** 提取源码里所有 <Button / <button 开标签，返回缺 type= 的「file:line 首行」。 */
function openingTagsWithoutType(src: string): string[] {
  const missing: string[] = [];
  const re = /<(Button|button)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    let quote: string | null = null;
    let end = -1;
    for (let i = m.index + m[0].length; i < src.length; i++) {
      const c = src[i];
      if (quote) {
        if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') {
        quote = c;
        continue;
      }
      if (c === '>') {
        end = i;
        break;
      }
    }
    if (end === -1) continue;
    const tag = src.slice(m.index, end + 1);
    if (!/\btype=/.test(tag)) {
      const line = src.slice(0, m.index).split('\n').length;
      missing.push(`:${line} ${tag.split('\n')[0].slice(0, 80)}`);
    }
    re.lastIndex = end + 1;
  }
  return missing;
}

describe('source-level: swept composer-form buttons all declare type', () => {
  it('every <Button>/<button> opening tag in the swept files has type=', () => {
    const repoRoot = process.cwd();
    const offenders: string[] = [];
    for (const rel of SWEPT_FILES) {
      const src = fs.readFileSync(path.join(repoRoot, rel), 'utf-8');
      for (const miss of openingTagsWithoutType(src)) offenders.push(`${rel}${miss}`);
    }
    expect(offenders).toEqual([]); // 缺 type = 隐式 submit，点按钮会交表单
  });
});

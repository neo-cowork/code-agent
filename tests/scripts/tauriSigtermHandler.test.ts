// 桌面壳的退出信号处理（N-FIX-TAURI-SIGTERM-ORPHAN-WEBSERVER）：ctrlc 不开 termination 特性只接 SIGINT，
// SIGTERM 走默认动作直接杀壳，cleanup_server 不跑，webServer 成孤儿占着端口。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('桌面壳收 SIGTERM 也走清理', () => {
  it('ctrlc 依赖开了 termination 特性', () => {
    const cargo = readFileSync(resolve(__dirname, '../../src-tauri/Cargo.toml'), 'utf-8');
    const line = cargo.split('\n').find((l) => /^ctrlc\s*=/.test(l)) ?? '';
    expect(line).toMatch(/features\s*=\s*\[[^\]]*"termination"/);
  });
});

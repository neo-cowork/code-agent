// Swift 小工具的增量构建判断（N-FIX-SWIFT-HELPER-STALE-BUILD）：
// worktree-bootstrap 把主树旧产物拷进来后，产物时间比源码新；按时间判断会永远跳过编译。
// 用假 swiftc / uname 真跑构建脚本，不需要真编译器。
import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = resolve(__dirname, '../..');
let dir = '';

function setup(): { run: () => string } {
  dir = mkdtempSync(join(tmpdir(), 'swift-helper-'));
  const bin = join(dir, 'bin');
  const scripts = join(dir, 'scripts');
  for (const d of [bin, scripts]) spawnSync('mkdir', ['-p', d]);
  // 假 swiftc：把 -o 指定的产物写成「新编」
  writeFileSync(join(bin, 'swiftc'), '#!/bin/bash\nwhile [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done\necho fresh > "$out"\n');
  writeFileSync(join(bin, 'uname'), '#!/bin/bash\necho Darwin\n');
  for (const f of ['swiftc', 'uname']) chmodSync(join(bin, f), 0o755);
  copyFileSync(join(REPO, 'scripts/build-audio-capture.sh'), join(scripts, 'build-audio-capture.sh'));
  for (const n of ['system-audio-capture', 'voice-aec-io']) writeFileSync(join(scripts, `${n}.swift`), `// ${n} v1\n`);
  return {
    run: () => spawnSync('bash', [join(scripts, 'build-audio-capture.sh')], {
      encoding: 'utf-8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SWIFT_BUILD_ARCH: '' },
    }).stdout,
  };
}

afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('Swift 小工具按源码内容判断是否重编', () => {
  it('拷来的旧产物比源码新也会重编；第二次跳过；改源码再重编', () => {
    const { run } = setup();
    const out = join(dir, 'scripts/system-audio-capture');
    writeFileSync(out, 'stale');
    const future = new Date(Date.now() + 60_000);
    utimesSync(out, future, future); // 模拟 worktree 引导拷来的产物：时间比源码新

    expect(run()).toContain('→ 编译 system-audio-capture');
    expect(readFileSync(out, 'utf-8')).toBe('fresh\n');

    expect(run()).toContain('✓ system-audio-capture 已是最新');

    writeFileSync(join(dir, 'scripts/system-audio-capture.swift'), '// v2\n');
    expect(run()).toContain('→ 编译 system-audio-capture');
  });
});

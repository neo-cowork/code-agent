// ============================================================================
// N-FIX-APPROVED-RM-PRE-DELETE-INVENTORY-CARD · 删前盘点循环不再自己出一张卡。
// 模型在 rm 之前常写一条只读盘点：`for p in <字面量路径>; do if [ -e "$p" ]; then …; else …; fi; done`。
// 同样的检查单条写（test -e / ls / stat）本来就免卡，写成循环却出卡 → 一次删除要点两下。
// 全部走公共入口 ToolExecutor.execute：
//  - 模型真实写法（引号字面量词表 + 一层 if/else + stat -f / ls / echo / printf）零审批，输出与真 sh 逐字一致
//  - 词表、循环体里任何非字面量 / 展开 / 写操作 / 嵌套结构 → 仍出卡
//  - 工作区外未点名的路径、用户 ask / deny 规则 → 仍出卡 / 仍拒绝
// ============================================================================

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/host/tools/shell/dynamicDescription', () => ({
  generateBashDescription: async () => null,
}));

const sessionMessages = vi.hoisted(() => [] as Array<{ role: string; isMeta?: boolean; content: string; attachments?: Array<{ path?: string }> }>);
vi.mock('../../../../src/host/services/core/databaseService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/host/services/core/databaseService')>();
  return { ...actual, getDatabase: () => ({
    getMessages: () => sessionMessages,
    getSession: () => null,
    getDb: () => ({ prepare: () => ({
      get: () => ({ metadata: JSON.stringify({ writeGrantRoot: undefined }) }),
      all: () => [],
    }) }),
  }) as unknown as ReturnType<typeof actual.getDatabase> };
});

import { getToolCache } from '../../../../src/host/services/infra/toolCache';
import { getProtocolRegistry } from '../../../../src/host/tools/protocolRegistry';
import { resetPermissionModeManager } from '../../../../src/host/permissions/modes';
import { getPolicyEngine, resetPolicyEngine } from '../../../../src/host/permissions/policyEngine';
import { getDecisionHistory, resetDecisionHistory } from '../../../../src/host/security/decisionHistory';
import { ToolExecutor } from '../../../../src/host/tools/toolExecutor';
import { compileReadOnlyProbePlan } from '../../../../src/host/security/readOnlyProbePlan';

const SESSION = 'ro-probe-inventory-loop-session';
/** shell 单引号词（引号字面量词表的写法）。 */
const sq = (word: string): string => `'${word}'`;

describe('删前盘点循环（只读、字面量路径）不出卡', () => {
  let root: string;
  let fx: string;
  let elsewhere: string;
  let permissionAsks: string[];

  beforeAll(() => { getProtocolRegistry(); });

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ro-probe-loop-')));
    fx = path.join(root, 'work');
    elsewhere = path.join(root, 'elsewhere');
    await fs.mkdir(fx);
    await fs.mkdir(elsewhere);
    for (const name of ['a.txt', 'b c.txt', '合同.md', 'draft (v2).txt', "it's.txt"]) await fs.writeFile(path.join(fx, name), name);
    for (const name of ['old-report-1.docx', 'old-report-2.docx']) await fs.writeFile(path.join(elsewhere, name), name);
    sessionMessages.length = 0;
    permissionAsks = [];
    delete process.env.CODE_AGENT_READONLY_PROBE;
    getToolCache().clear();
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

  function run(command: string) {
    const ex = new ToolExecutor({
      requestPermission: async (req) => { permissionAsks.push(String((req as { details?: { command?: string } }).details?.command ?? 'ask')); return false; },
      workingDirectory: fx,
    });
    ex.setAuditEnabled(false);
    return ex.execute('Bash', { command }, { sessionId: SESSION });
  }
  const probeRows = () => getDecisionHistory().getAll().filter((e) => e.reason === 'readonly-probe-plan');

  /** 真实 shell 的期望输出：Bash 工具的结果格式 = [cwd] + stdout (+ [stderr])。 */
  function realBash(command: string): string {
    const r = spawnSync('/bin/sh', ['-c', command], { cwd: fx, encoding: 'utf8' });
    expect(r.status, `real shell exit: ${r.stderr}`).toBe(0);
    return `[cwd: ${fx}]\n${r.stdout}${r.stderr ? `\n[stderr]: ${r.stderr}` : ''}`;
  }

  /** 免卡：没有审批请求，探测计划在进程内跑完，决策留痕，输出与真 shell 一致。 */
  async function expectFreed(command: string) {
    const result = await run(command);
    expect(permissionAsks).toEqual([]);
    expect(result.success).toBe(true);
    expect(result.metadata?.readonlyProbePlan).toBe(true);
    expect(probeRows()).toHaveLength(1);
    expect(probeRows()[0]).toMatchObject({ outcome: 'auto-approve', reason: 'readonly-probe-plan' });
    expect(result.output).toBe(realBash(command));
  }

  /** 仍出卡：审批请求带着原命令，探测没有放行。 */
  async function expectStillAsks(command: string) {
    const result = await run(command);
    expect(permissionAsks).toContain(command);
    expect(result.metadata?.readonlyProbePlan).toBeUndefined();
    expect(probeRows()).toEqual([]);
    return result;
  }

  /** 不出卡、也不执行：命令分析拆不了词的那几种构造，被更早的 fail-closed 闸门直接拒绝。 */
  async function expectHardDenied(command: string) {
    const result = await run(command);
    expect(permissionAsks).toEqual([]);
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('fail-closed');
    expect(getDecisionHistory().getAll().some((entry) => entry.outcome === 'policy-deny' && entry.reason === 'command_analysis_failed/fail-closed')).toBe(true);
    expect(result.metadata?.readonlyProbePlan).toBeUndefined();
    expect(probeRows()).toEqual([]);
  }

  const a = () => path.join(fx, 'a.txt');
  const missing = () => path.join(fx, 'missing.txt');
  const out1 = () => path.join(elsewhere, 'old-report-1.docx');
  const out2 = () => path.join(elsewhere, 'old-report-2.docx');

  /** 上一轮取证里模型的写法：引号字面量词表 + 一层 if/else + echo / ls。 */
  function evidenceShape(words: string[]): string {
    return `for p in ${words.map(sq).join(' ')}; do if [ -e "$p" ]; then echo "STILL: $p"; ls -l "$p"; else echo "GONE: $p"; fi; done`;
  }
  /** dogfood 真跑（基线 run 3）里模型的写法：裸词表、多行 if/else、stat -f 与 printf。 */
  function dogfoodShape(words: string[]): string {
    return [
      `for f in ${words.join(' ')}; do`,
      '  if [ -e "$f" ]; then',
      `    stat -f '存在 | %N | %z 字节 | 修改 %Sm' "$f"`,
      '  else',
      `    printf '不存在 | %s\\n' "$f"`,
      '  fi',
      'done',
    ].join('\n');
  }

  describe('positive: 盘点循环零审批，进程内执行', () => {
    it('上一轮取证的写法（引号词表 + if/else + echo/ls）免卡，决策留痕 readonly-probe-plan', async () => {
      await expectFreed(evidenceShape([a(), missing()]));
    });

    it('dogfood 真跑的写法（裸词表、多行 if/else、stat -f 与 printf）免卡', async () => {
      await expectFreed(dogfoodShape([a(), missing()]));
    });

    it('模型把循环写成单行：if … then stat … else printf … fi', async () => {
      await expectFreed(`for f in ${a()} ${missing()}; do if [ -e "$f" ]; then stat -f '仍在 | %N | %z 字节' "$f"; else printf '已删除 | %s\\n' "$f"; fi; done`);
    });

    it('引号词表 + test -e && echo（没有 if）免卡', async () => {
      await expectFreed(`for p in ${sq(a())} ${sq(path.join(fx, 'b c.txt'))}; do test -e "$p" && echo "EXISTS: $p"; done`);
    });

    it('带空格的路径（引号词表）免卡', async () => {
      await expectFreed(evidenceShape([path.join(fx, 'b c.txt')]));
    });

    it('中文路径（引号词表）免卡', async () => {
      await expectFreed(`for p in ${sq(path.join(fx, '合同.md'))}; do if [ -e "$p" ]; then echo "STILL: $p"; ls -l "$p"; else echo "GONE: $p"; fi; done`);
    });

    it('空格 + 括号的路径（引号词表）免卡', async () => {
      await expectFreed(`for p in ${sq(path.join(fx, 'draft (v2).txt'))}; do if [ -e "$p" ]; then stat -f '%N | %z' "$p"; else printf 'GONE | %s\\n' "$p"; fi; done`);
    });

    it('双引号词里带单引号的路径免卡', async () => {
      await expectFreed(`for p in "${path.join(fx, "it's.txt")}"; do if [ -e "$p" ]; then stat -f '%N' "$p"; fi; done`);
    });

    it('裸词与引号词混在一个词表里免卡', async () => {
      await expectFreed(`for p in ${a()} ${sq(path.join(fx, 'b c.txt'))} ${sq(missing())}; do if [ -e "$p" ]; then echo "STILL: $p"; else echo "GONE: $p"; fi; done`);
    });

    it('双引号里的 ${p} 写法免卡', async () => {
      await expectFreed(`for p in ${sq(path.join(fx, 'b c.txt'))}; do if [ -e "\${p}" ]; then stat -f '%N' "\${p}"; fi; done`);
    });

    it('没有 else 的 if 免卡', async () => {
      await expectFreed(`for p in ${a()} ${missing()}; do if [ -e "$p" ]; then ls -l "$p"; fi; done`);
    });

    it('没有 else 的 if 条件不成立时以 0 结束（与 shell 一致），前一条命令失败也不影响', async () => {
      await expectFreed(`test -e ${missing()}; for p in ${missing()}; do if [ -e "$p" ]; then ls -l "$p"; fi; done; echo "exit=$?"`);
    });

    it('if 的条件用 test 写免卡', async () => {
      await expectFreed(`for p in ${a()}; do if test -e "$p"; then echo "STILL: $p"; else echo "GONE: $p"; fi; done`);
    });

    it('循环体里 if 前后还有别的语句免卡', async () => {
      await expectFreed(`for p in ${a()}; do echo "== $p =="; if [ -e "$p" ]; then ls -l "$p"; fi; echo "checked $p"; done`);
    });

    it('循环前后各有一条命令免卡', async () => {
      await expectFreed(`echo "== check =="; for p in ${a()}; do if [ -e "$p" ]; then echo "STILL: $p"; fi; done; echo "end"`);
    });

    it('[ -e <路径> ] 在循环外也是 test 的别名，不再出卡', async () => {
      await expectFreed(`[ -e "${a()}" ] && echo yes`);
      permissionAsks = [];
      resetDecisionHistory();
      await expectFreed(`[ -e "${missing()}" ] || echo no`);
    });

    it('walkthrough：用户点名了 Downloads 里的两个旧报告 → 盘点循环免卡', async () => {
      sessionMessages.push({ role: 'user', content: `这两份旧报告不要了，帮我删掉：\n${out1()}\n${out2()}` });
      await expectFreed(evidenceShape([out1(), out2()]));
    });

    it('用户点名的带空格路径（引号词表）免卡', async () => {
      const named = path.join(elsewhere, 'old report 2.docx');
      await fs.writeFile(named, 'x');
      sessionMessages.push({ role: 'user', content: `删掉 ${named}` });
      await expectFreed(`for p in ${sq(named)}; do if [ -e "$p" ]; then stat -f '%N | %z' "$p"; else echo "GONE: $p"; fi; done`);
    });
  });

  /** 证明不了只读的形状：编译器直接返回 null。 */
  const unproven: Array<[string, () => string]> = [
    // ---- 词表 ----
    ['词表里的词带通配符 *（引号内）', () => `for p in ${sq(`${fx}/*`)}; do ls -l "$p"; done`],
    ['词表里的词带通配符 *（无引号）', () => `for p in ${fx}/*; do if [ -e "$p" ]; then ls -l "$p"; fi; done`],
    ['词表里的词带 ?（引号内）', () => `for p in ${sq(`${fx}/a?.txt`)}; do ls -l "$p"; done`],
    ['词表是 "$x" 变量', () => 'for p in "$x"; do ls -l "$p"; done'],
    ['词表是 $x 变量（无引号）', () => 'for p in $x; do ls -l "$p"; done'],
    ['词表是 $(…) 命令替换（引号内）', () => "for p in '$(ls)'; do ls -l \"$p\"; done"],
    ['词表带反引号（引号内）', () => 'for p in \'`ls`\'; do ls -l "$p"; done'],
    ['词表带 ~（引号内）', () => `for p in '~/a.txt'; do ls -l "$p"; done`],
    ['词表带 ~（无引号）', () => 'for p in ~/a.txt; do ls -l "$p"; done'],
    ['词表里的词以 - 开头（引号内）', () => `for p in '-rf'; do echo "$p"; done`],
    ['词表里的词以 - 开头（无引号）', () => 'for p in -rf; do echo "$p"; done'],
    ['词表是花括号展开（非字面量）', () => `for f in ${fx}/old-report-{1,2}.docx; do if [ -e "$f" ]; then stat -f 'x' "$f"; else printf 'y\\n' "$f"; fi; done`],
    ['词表是花括号展开 {a,b}', () => 'for f in {a,b}; do ls -l "$f"; done'],
    ['引号词后面还粘着别的字符（拼接词）', () => `for p in ${sq(a())}.bak; do ls -l "$p"; done`],
    ['引号词后面粘着另一个引号词', () => `for p in ${sq(`${fx}/a`)}${sq('.txt')}; do ls -l "$p"; done`],
    ['引号词里带反斜杠', () => `for p in '${fx}/a\\b.txt'; do ls -l "$p"; done`],
    ['双引号词里转义了双引号（同类引号）', () => `for p in "${fx}/a\\"b"; do ls -l "$p"; done`],
    ['空的引号词', () => `for p in ''; do ls -l "$p"; done`],
    // ---- 循环体 ----
    ['then 分支里有 rm', () => `for p in ${a()}; do if [ -e "$p" ]; then rm "$p"; fi; done`],
    ['if 之后还有 rm', () => `for p in ${a()}; do if [ -e "$p" ]; then ls "$p"; fi; rm "$p"; done`],
    ['then 分支里有 > 重定向', () => `for p in ${a()}; do if [ -e "$p" ]; then echo "$p" > out.txt; fi; done`],
    ['stat 的输出重定向到文件', () => `for p in ${a()}; do stat -f '%N' "$p" > out.txt; done`],
    ['then 分支里有 >> 追加重定向', () => `for p in ${a()}; do if [ -e "$p" ]; then echo "$p" >> out.txt; fi; done`],
    ['then 分支里有 | 管道接 tee', () => `for p in ${a()}; do if [ -e "$p" ]; then echo "$p" | tee out.txt; fi; done`],
    ['then 分支里有 mv', () => `for p in ${a()}; do if [ -e "$p" ]; then mv "$p" "$p.bak"; fi; done`],
    ['then 分支里有 curl', () => `for p in ${a()}; do if [ -e "$p" ]; then curl https://example.test; fi; done`],
    ['嵌套 for', () => `for p in ${a()}; do for q in ${a()}; do ls "$q"; done; done`],
    ['嵌套 if', () => `for p in ${a()}; do if [ -e "$p" ]; then if [ -f "$p" ]; then echo x; fi; fi; done`],
    ['elif', () => `for p in ${a()}; do if [ -e "$p" ]; then echo a; elif [ -d "$p" ]; then echo b; else echo c; fi; done`],
    ['if 没有收尾的 fi', () => `for p in ${a()}; do if [ -e "$p" ]; then echo a; done`],
    ['then 分支是空的', () => `for p in ${a()}; do if [ -e "$p" ]; then fi; done`],
    ['then 前面缺分号', () => `for p in ${a()}; do if [ -e "$p" ] then echo a; fi; done`],
    ['条件不是 test（ls）', () => `for p in ${a()}; do if ls "$p" >/dev/null; then echo a; fi; done`],
    ['条件是两条命令', () => `for p in ${a()}; do if [ -e "$p" ] && [ -f "$p" ]; then echo a; fi; done`],
    ['then 分支里用 && 连接', () => `for p in ${a()}; do if [ -e "$p" ]; then echo a && echo b; fi; done`],
    ['[ 没有收尾的 ]', () => `for p in ${a()}; do if [ -e "$p"; then echo a; fi; done`],
    ['[ 的操作数多了', () => `for p in ${a()}; do if [ -e "$p" "$p" ]; then echo a; fi; done`],
    ['[ 用了不认的操作符 -s', () => `for p in ${a()}; do if [ -s "$p" ]; then echo a; fi; done`],
    ['[ 前面有取反 !', () => `for p in ${a()}; do if ! [ -e "$p" ]; then echo a; fi; done`],
    ['循环变量写在单引号里（字面量）', () => `for p in ${a()}; do echo '$p'; done`],
    ['引号词表 + 引号外的 $p 引用', () => `for p in ${sq(path.join(fx, 'b c.txt'))}; do ls -l $p; done`],
    ['循环体引用别的变量 $HOME', () => `for p in ${a()}; do if [ -e "$p" ]; then echo "$HOME"; fi; done`],
    ['循环体里引用循环变量当命令名', () => `for p in ${a()}; do if [ -e "$p" ]; then "$p"; fi; done`],
    ['分支里的 echo 取 $?（if 里的 $? 是条件的退出码）', () => `for p in ${a()}; do if [ -e "$p" ]; then echo "exit=$?"; fi; done`],
    ['done 之后换行接 rm', () => `for p in ${a()}; do if [ -e "$p" ]; then echo a; fi; done\nrm -f ${a()}`],
    ['done 之后重定向', () => `for p in ${a()}; do if [ -e "$p" ]; then echo a; fi; done > out.txt`],
    ['循环外单独一条 if（不在本次范围）', () => `if [ -e "${a()}" ]; then echo "STILL"; else echo "GONE"; fi`],
    ['词表超过 32 个词', () => { const words = Array.from({ length: 33 }, (_, i) => `w${i}`); return `for p in ${words.join(' ')}; do echo "$p"; done`; }],
    // ---- stat ----
    ['stat 带 -L', () => `for p in ${a()}; do stat -L -f '%N' "$p"; done`],
    ['stat 带 -t 时间格式', () => `for p in ${a()}; do stat -f '%Sm' -t '%Y' "$p"; done`],
    ['stat 用缺省格式', () => `for p in ${a()}; do stat "$p"; done`],
    ['stat 的格式以 - 开头', () => `for p in ${a()}; do stat -f -x "$p"; done`],
    ['stat 的格式是空的', () => `for p in ${a()}; do stat -f '' "$p"; done`],
    ['stat 没有路径（会去读 stdin）', () => `for p in ${a()}; do echo "$p"; stat -f '%z'; done`],
    ['stat 的路径以 - 开头', () => `for p in ${a()}; do stat -f '%N' -v; done`],
  ];

  /** 编译返回 null，且命令分析拆不了词的那几种：更早的 fail-closed 闸门直接拒绝，连卡都不出。 */
  const hardDenied: Array<[string, () => string]> = [
    ['词表是 $(…) 命令替换（无引号）', () => 'for p in $(ls); do ls -l "$p"; done'],
    ['引号没闭合', () => `for p in ${sq(a())} '${fx}/b; do ls -l "$p"; done`],
    ['循环体里有 $(…) 命令替换', () => `for p in ${a()}; do if [ -e "$p" ]; then echo "$(id -un)"; fi; done`],
    ['循环体里有反引号', () => `for p in ${a()}; do if [ -e "$p" ]; then echo \`id -un\`; fi; done`],
  ];

  describe('negative: 证明不了只读 → 编译返回 null，仍出卡', () => {
    for (const [name, build] of unproven) {
      it(name, async () => {
        const command = build();
        expect(compileReadOnlyProbePlan(command, { homeDir: os.homedir(), platform: 'darwin' }), command).toBeNull();
        await expectStillAsks(command);
        expect(await fs.readFile(a(), 'utf8')).toBe('a.txt');
        await expect(fs.stat(path.join(fx, 'out.txt'))).rejects.toThrow();
      });
    }

    it('一键关闭探测（CODE_AGENT_READONLY_PROBE=off）→ 盘点循环照旧出卡', async () => {
      process.env.CODE_AGENT_READONLY_PROBE = 'off';
      await expectStillAsks(evidenceShape([a()]));
    });

    for (const [name, build] of hardDenied) {
      it(`${name} → 编译返回 null，被 fail-closed 闸门直接拒绝`, async () => {
        const command = build();
        expect(compileReadOnlyProbePlan(command, { homeDir: os.homedir(), platform: 'darwin' }), command).toBeNull();
        await expectHardDenied(command);
      });
    }
  });

  describe('negative: 只读可证，但路径 / 规则不放行 → 仍出卡', () => {
    const ctx = { homeDir: os.homedir(), platform: 'darwin' as const };

    it('工作区外、用户没点名的路径：引号词表写法仍出卡', async () => {
      const command = evidenceShape([out1()]);
      expect(compileReadOnlyProbePlan(command, ctx), command).not.toBeNull();
      await expectStillAsks(command);
    });

    it('工作区外、用户没点名的路径：模型真实的裸词表写法仍出卡', async () => {
      const command = dogfoodShape([out1(), out2()]);
      expect(compileReadOnlyProbePlan(command, ctx), command).not.toBeNull();
      await expectStillAsks(command);
    });

    it('模型自己写的（isMeta）用户消息里出现路径不算点名 → 仍出卡', async () => {
      sessionMessages.push({ role: 'user', isMeta: true, content: `盘点 ${out1()}` });
      await expectStillAsks(evidenceShape([out1()]));
    });

    it('点名的是另一个后缀相同的路径 → 仍出卡', async () => {
      sessionMessages.push({ role: 'user', content: `看看 ${out1()}.bak 在不在` });
      await expectStillAsks(evidenceShape([out1()]));
    });

    it('工作区里的符号链接指向区外 → 仍出卡', async () => {
      await fs.symlink(elsewhere, path.join(fx, 'link'));
      await expectStillAsks(`for p in ${path.join(fx, 'link')}/old-report-1.docx; do if [ -e "$p" ]; then ls -l "$p"; fi; done`);
    });

    it('then 分支里 cd 到工作区外 → 仍出卡', async () => {
      const command = `for p in ${a()}; do if [ -e "$p" ]; then cd /; fi; done`;
      expect(compileReadOnlyProbePlan(command, ctx), command).not.toBeNull();
      await expectStillAsks(command);
    });

    it('凭据路径 ~/.ssh/id_rsa（绝对路径、引号词表）仍出卡', async () => {
      await expectStillAsks(`for p in ${sq(path.join(os.homedir(), '.ssh', 'id_rsa'))}; do if [ -e "$p" ]; then stat -f '%z' "$p"; else echo "GONE: $p"; fi; done`);
    });

    it('用户 ask 规则命中循环体里的 stat → 仍出卡', async () => {
      getPolicyEngine().loadUserRules({ ask: ['Bash(stat *)'] });
      await expectStillAsks(dogfoodShape([a()]));
    });

    it('用户 ask 规则命中循环体里的 ls → 仍出卡', async () => {
      getPolicyEngine().loadUserRules({ ask: ['Bash(ls *)'] });
      await expectStillAsks(evidenceShape([a()]));
    });

    it('用户 ask 规则命中条件里的 test → 仍出卡', async () => {
      getPolicyEngine().loadUserRules({ ask: ['Bash(test *)'] });
      await expectStillAsks(`for p in ${a()}; do if test -e "$p"; then echo a; fi; done`);
    });

    it('用户 ask 规则写的是路径（带空格、引号词表）→ 仍出卡', async () => {
      getPolicyEngine().loadUserRules({ ask: ['Bash(ls *b c.txt*)'] });
      await expectStillAsks(`for p in ${sq(path.join(fx, 'b c.txt'))}; do if [ -e "$p" ]; then ls -l "$p"; else echo "GONE: $p"; fi; done`);
    });

    it('用户 ask 规则命中整条循环 → 仍出卡', async () => {
      getPolicyEngine().loadUserRules({ ask: ['Bash(for *)'] });
      await expectStillAsks(evidenceShape([a()]));
    });

    it('用户 deny 规则命中循环体里的 stat → 不出卡，直接拒绝', async () => {
      getPolicyEngine().loadUserRules({ deny: ['Bash(stat *)'] });
      const result = await run(dogfoodShape([a()]));
      expect(result.success).toBe(false);
      expect(permissionAsks).toEqual([]);
      expect(probeRows()).toEqual([]);
    });
  });

  describe('compile level：计划长什么样', () => {
    const ctx = { homeDir: os.homedir(), platform: 'darwin' as const };

    it('To do 2 点名的每种形状都返回计划', () => {
      const plans = [
        `for p in ${sq(a())} ${sq(missing())}; do test -e "$p" && echo "EXISTS: $p"; done`,
        `for p in "${a()}"; do test -e "$p" && echo "EXISTS: $p"; done`,
        `for p in ${sq(path.join(fx, 'b c.txt'))} ${sq(path.join(fx, '合同.md'))}; do if [ -e "$p" ]; then ls -l "$p"; else echo "GONE: $p"; fi; done`,
        dogfoodShape([a(), missing()]),
        `for p in ${sq(a())}; do if test -f "$p"; then echo "FILE: $p"; fi; done`,
        `for p in ${sq(fx)}; do if [ -d "$p" ]; then ls "$p"; else echo "GONE: $p"; fi; done`,
      ];
      for (const command of plans) expect(compileReadOnlyProbePlan(command, ctx), command).not.toBeNull();
    });

    it('if/else 压平成「条件成立才执行」的步骤：then 两条、else 一条', () => {
      const plan = compileReadOnlyProbePlan(evidenceShape([a()]), ctx);
      expect(plan?.steps.map((step) => step.cmd.kind === 'when' ? [step.cmd.negate, step.cmd.cmd.kind] : ['unguarded', step.cmd.kind]))
        .toEqual([[false, 'echo'], [false, 'ls'], [true, 'echo']]);
    });

    it('没有 else 的 if 末尾补一条「条件不成立才执行」的空步', () => {
      const plan = compileReadOnlyProbePlan(`for p in ${a()}; do if [ -e "$p" ]; then ls -l "$p"; fi; done`, ctx);
      expect(plan?.steps.map((step) => step.cmd.kind === 'when' ? [step.cmd.negate, step.cmd.cmd.kind] : ['unguarded', step.cmd.kind]))
        .toEqual([[false, 'ls'], [true, 'noop']]);
    });

    it('To do 3 点名的每个反例都返回 null', () => {
      for (const [name, build] of [...unproven, ...hardDenied]) {
        const command = build();
        expect(compileReadOnlyProbePlan(command, ctx), `${name}: ${command}`).toBeNull();
      }
    });

    it('200 步上限照旧按语句数计（分支里的每条语句各算一步）', () => {
      const words = Array.from({ length: 32 }, (_, i) => `w${i}`).join(' ');
      const five = compileReadOnlyProbePlan(`for p in ${words}; do if [ -e "$p" ]; then echo 1; echo 2; echo 3; echo 4; fi; done`, ctx);
      expect(five?.steps).toHaveLength(160);
      expect(compileReadOnlyProbePlan(`for p in ${words}; do if [ -e "$p" ]; then echo 1; echo 2; echo 3; echo 4; echo 5; echo 6; echo 7; fi; done`, ctx)).toBeNull();
    });

    it('绑定值不进文本的那条路：原文留着 "$p"，另附按 shell 单引号规则改写后的展开文本供规则匹配', () => {
      const plan = compileReadOnlyProbePlan(`for p in ${sq(path.join(fx, 'b c.txt'))} "${path.join(fx, "it's.txt")}"; do ls -l "$p"; done`, ctx);
      expect(plan?.steps.map((step) => step.source)).toEqual(['ls -l "$p"', 'ls -l "$p"']);
      expect(plan?.steps.map((step) => step.extraSources)).toEqual([[`ls -l ${sq(path.join(fx, 'b c.txt'))}`], [`ls -l '${path.join(fx, "it'\\''s.txt")}'`]]);
    });
  });
});

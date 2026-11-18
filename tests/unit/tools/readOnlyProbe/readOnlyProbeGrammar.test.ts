// ============================================================================
// N-FIX-UX-APPROVAL-CARD-REDESIGN-FU1-READONLY-FREE-FU1 · 计划文法扩展：
// which / 版本探测 / pdfinfo·pdftotext 到 stdout / 字面量 for 循环。
// 走后台任务执行器的生产入口（同 readOnlyProbeBackgroundTask.test.ts 的装配）。
// ============================================================================

import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/host/tools/shell/dynamicDescription', () => ({
  generateBashDescription: async () => null,
}));

import { getToolCache } from '../../../../src/host/services/infra/toolCache';
import { getProtocolRegistry } from '../../../../src/host/tools/protocolRegistry';
import { getPermissionModeManager, resetPermissionModeManager } from '../../../../src/host/permissions/modes';
import { getPolicyEngine, resetPolicyEngine } from '../../../../src/host/permissions/policyEngine';
import { getDecisionHistory, resetDecisionHistory } from '../../../../src/host/security/decisionHistory';
import { ToolExecutor } from '../../../../src/host/tools/toolExecutor';
import { mintDelegatedTurnOrigin } from '../../../../src/host/agent/messageOrigin';
import { compileReadOnlyProbePlan } from '../../../../src/host/security/readOnlyProbePlan';

const SESSION = 'ro-probe-grammar-session';
const HAS_POPPLER = existsSync('/opt/homebrew/bin/pdftotext') || existsSync('/usr/bin/pdftotext') || existsSync('/usr/local/bin/pdftotext');

function minimalPdf(text: string): string {
  const stream = `BT /F1 12 Tf 50 700 Td (${text}) Tj ET`;
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  return `${out}trailer<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
}

describe('只读探测文法扩展（后台任务执行器，async_agent）', () => {
  let root: string;
  let pdf: string;
  let asks: string[];

  beforeAll(() => { getProtocolRegistry(); });
  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ro-probe-grammar-')));
    pdf = path.join(root, 'x.pdf');
    await fs.writeFile(pdf, minimalPdf('Party A pays Party B within 30 days'));
    asks = [];
    getToolCache().clear();
    resetPermissionModeManager();
    resetPolicyEngine();
    resetDecisionHistory();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    resetPolicyEngine();
    resetPermissionModeManager();
    await fs.rm(root, { recursive: true, force: true });
  });

  const requestPermission = async (req: unknown) => { asks.push(String((req as { details?: { command?: string } }).details?.command ?? 'ask')); return false; };
  const probeRows = () => getDecisionHistory().getAll().filter((e) => e.reason === 'readonly-probe-plan');

  function run(command: string) {
    const ex = new ToolExecutor({ requestPermission, workingDirectory: root, ledgerOrigin: 'desktop', executionTopology: 'async_agent' });
    ex.setAuditEnabled(false);
    const ids = { sessionId: SESSION, runId: 'bg-run-1', turnId: 'turn-1' };
    return ex.execute('Bash', { command }, {
      ...ids, sourceMessageId: 'user-1', turnOrigin: mintDelegatedTurnOrigin(ids), currentAttachments: [{ path: pdf }],
    } as never);
  }

  describe('positive: no card, in-process', () => {
    const positives: Array<[string, () => string]> = [
      ['which ls cat', () => 'which ls cat'],
      ['python3 --version', () => 'python3 --version'],
      ['command -v with several names', () => 'command -v ls cat'],
      ['version probe piped to head', () => 'python3 --version 2>&1 | head -2'],
      ['for-loop over literal words with command -v', () => 'for t in ls cat; do command -v "$t"; done'],
      ['echo prefix then for-loop', () => 'echo "=== tools ==="; for t in ls cat; do command -v $t; done'],
    ];
    for (const [name, build] of positives) {
      it(name, async () => {
        const r = await run(build());
        expect(asks).toEqual([]);
        expect(r.success).toBe(true);
        expect(r.metadata?.readonlyProbePlan).toBe(true);
        expect(probeRows().length).toBe(1);
      });
    }

    it.skipIf(!HAS_POPPLER)('pdftotext -v', async () => {
      const r = await run('pdftotext -v');
      expect(asks).toEqual([]);
      expect(r.metadata?.readonlyProbePlan).toBe(true);
      expect(probeRows().length).toBe(1);
    });
    it.skipIf(!HAS_POPPLER)('pdfinfo <file>', async () => {
      const r = await run(`pdfinfo ${pdf}`);
      expect(asks).toEqual([]);
      expect(r.metadata?.readonlyProbePlan).toBe(true);
      expect(String(r.output)).toContain('Pages:');
      expect(probeRows().length).toBe(1);
    });
    it.skipIf(!HAS_POPPLER)('pdftotext -layout <file> -', async () => {
      const r = await run(`pdftotext -layout ${pdf} -`);
      expect(asks).toEqual([]);
      expect(r.metadata?.readonlyProbePlan).toBe(true);
      expect(String(r.output)).toContain('Party A pays Party B');
      expect(probeRows().length).toBe(1);
    });
  });

  describe('negative: still carded or denied on the same path', () => {
    const expectNotProbed = (r: { metadata?: Record<string, unknown> }) => {
      expect(r.metadata?.readonlyProbePlan).toBeUndefined();
      expect(probeRows()).toEqual([]);
    };

    it('pdftotext <file> (would write x.txt)', async () => {
      const r = await run(`pdftotext ${pdf}`);
      expectNotProbed(r);
      expect(asks.length).toBe(1);
    });
    it('pdftotext <file> <out.txt>', async () => {
      const r = await run(`pdftotext ${pdf} ${path.join(root, 'out.txt')}`);
      expectNotProbed(r);
      expect(asks.length).toBe(1);
    });
    it('./tool --version', async () => {
      const r = await run('./tool --version');
      expectNotProbed(r);
      expect(asks.length).toBe(1);
    });
    it('python3 -v (verbose mode, not a version flag)', async () => {
      const r = await run('python3 -v');
      expectNotProbed(r);
      expect(asks.length).toBe(1);
    });
    it('pdfinfo ~/.ssh/id_rsa', async () => {
      const r = await run('pdfinfo ~/.ssh/id_rsa');
      expectNotProbed(r);
    });
    it('a Bash deny rule on the command still denies', async () => {
      getPolicyEngine().loadUserRules({ deny: ['Bash(pdfinfo *)'] });
      const r = await run(`pdfinfo ${pdf}`);
      expect(r.success).toBe(false);
      expectNotProbed(r);
    });
    it.skipIf(!HAS_POPPLER)('a path under a user Read deny rule is not probed', async () => {
      getPolicyEngine().loadUserRules({ deny: [`Read(${root}/**)`] });
      const r = await run(`pdfinfo ${pdf}`);
      expectNotProbed(r);
    });
    it('command -v with a missing name is not silently accepted (non-zero exit goes to the card)', async () => {
      const r = await run('command -v ls no-such-tool-xyz');
      expectNotProbed(r);
    });
    it('version probe piped to anything but head', async () => {
      const r = await run('python3 --version | tee out.txt');
      expectNotProbed(r);
    });
    it('for loop with a write body (rm)', async () => {
      const r = await run('for t in a b; do rm "$t"; done');
      expectNotProbed(r);
      expect(asks.length).toBe(1);
    });
    it('for loop over command substitution', async () => {
      const r = await run('for t in $(ls); do command -v "$t"; done');
      expectNotProbed(r);
    });
    it('readOnly permission mode', async () => {
      getPermissionModeManager().setSessionMode(SESSION, 'readOnly', true, 'external');
      const r = await run('which ls cat');
      expectNotProbed(r);
    });
  });

  // 不依赖 poppler / 任何本机工具、不在 skipIf 后：CI 无 poppler 时这组仍然执行。
  describe('version/help probe allowlist (compile level)', () => {
    const ctx = { homeDir: os.homedir(), platform: 'darwin' as const };
    it('programs off the allowlist never compile', () => {
      for (const c of ['pbcopy --version', 'pbcopy -h', 'pbpaste --version', 'ps -h', 'ssh-keygen -h', 'rm -h', 'for t in rm; do $t -h; done', 'for t in pdftotext pbcopy; do $t --version; done']) {
        expect(compileReadOnlyProbePlan(c, ctx), c).toBeNull();
      }
    });
    it('allowlisted tools still compile', () => {
      for (const c of ['pdftotext -v', 'pdfinfo --version', 'for t in pdftotext pdfinfo; do $t --version; done']) {
        expect(compileReadOnlyProbePlan(c, ctx), c).not.toBeNull();
      }
    });
  });

  describe('compiler boundary', () => {
    const ctx = { homeDir: os.homedir(), platform: 'darwin' as const };
    it('accepts the new shapes', () => {
      for (const c of ['which a b', 'pdftotext -v', 'pdfinfo f.pdf', 'pdftotext -f 1 -l 2 -enc UTF-8 f.pdf -', 'node -V', 'for t in a b; do command -v "$t"; done']) {
        expect(compileReadOnlyProbePlan(c, ctx), c).not.toBeNull();
      }
    });
    it('rejects look-alikes', () => {
      for (const c of ['pdftotext f.pdf', 'pdftotext f.pdf o.txt', 'pdftotext f.pdf - extra', './x --version', '/bin/ls --version', 'python3 -v', 'bash -h',
        'for t in a b; do rm $t; done', 'for t in *; do command -v $t; done', 'for t in a; do echo \'$t\'; done', 'for t in a; do for u in b; do command -v $u; done; done']) {
        expect(compileReadOnlyProbePlan(c, ctx), c).toBeNull();
      }
    });
  });
});

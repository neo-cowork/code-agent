import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import type { ToolCall, ToolResult } from '../../../src/shared/contract';
import type { ContextAssembly } from '../../../src/host/agent/runtime/contextAssembly';
import type { RunFinalizer } from '../../../src/host/agent/runtime/runFinalizer';
import type { RuntimeContext } from '../../../src/host/agent/runtime/runtimeContext';
import { handleModifiedArtifactValidation } from '../../../src/host/agent/runtime/toolArtifactValidationLifecycle';
import { ArtifactState } from '../../../src/host/agent/runtime/artifactState';

// 端到端接线测试（不 mock 校验器）：Write 落盘 → light 契约 → 真实浏览器可玩性冒烟
// → 崩溃产物翻 failure 进 repair / 健康产物放行。复刻 dogfood 实锤的
// "验收通过却一玩就崩" 场景，验证 lifecycle 的 light 冒烟接线而非只测校验器本身。

const CRASH_GAME = `
  <!doctype html>
  <html>
  <body>
    <canvas id="game" width="400" height="300"></canvas>
    <script>
      window.__GAME_META__ = { domain: 'game', subtype: 'platformer', controls: { ArrowRight: 'move' } };
      const canvas = document.getElementById('game');
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#224';
      ctx.fillRect(0, 0, 400, 300);
      window.addEventListener('keydown', () => {
        ctx.fillRect(enemyX + 18, y + 10, 6, 6); // uncaught ReferenceError on first key press
      });
    </script>
  </body>
  </html>
`;

const HEALTHY_GAME = `
  <!doctype html>
  <html>
  <body>
    <canvas id="game" width="400" height="300"></canvas>
    <script>
      window.__GAME_META__ = { domain: 'game', subtype: 'platformer', controls: { ArrowRight: 'move' } };
      const canvas = document.getElementById('game');
      const ctx = canvas.getContext('2d');
      let x = 20;
      const keys = {};
      window.addEventListener('keydown', (event) => { keys[event.key] = true; });
      window.addEventListener('keyup', (event) => { keys[event.key] = false; });
      function frame() {
        if (keys.ArrowRight) x += 3;
        ctx.fillStyle = '#123';
        ctx.fillRect(0, 0, 400, 300);
        ctx.fillStyle = '#fc0';
        ctx.fillRect(x, 200, 24, 24);
        requestAnimationFrame(frame);
      }
      frame();
    </script>
  </body>
  </html>
`;

async function writeTempHtml(content: string, fileName: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'code-agent-lifecycle-playability-'));
  const filePath = path.join(dir, fileName);
  await writeFile(filePath, content, 'utf-8');
  return filePath;
}

function makeCtx(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
  return {
    workingDirectory: '/tmp',
    artifact: ArtifactState.forTest({
      repairGuard: undefined,
      validationPassedTargetFile: undefined,
    }),
    forceFinalResponseReason: undefined,
    forceFinalResponsePrompt: undefined,
    onEvent: vi.fn(),
    ...overrides,
  } as unknown as RuntimeContext;
}

function makeHarness(filePath: string, content: string) {
  const contextAssembly = { injectSystemMessage: vi.fn() } as unknown as ContextAssembly;
  const runFinalizer = { emitTaskProgress: vi.fn() } as unknown as RunFinalizer;
  const toolCall: ToolCall = {
    id: 'call_write_game',
    name: 'Write',
    arguments: { file_path: filePath, content },
  };
  const toolResult: ToolResult = { toolCallId: 'call_write_game', success: true, output: 'created' };
  return { contextAssembly, runFinalizer, toolCall, toolResult };
}

describe('lifecycle light contract + playability smoke wiring', () => {
  it('flips a crash-on-play game into repair on the light path', async () => {
    const filePath = await writeTempHtml(CRASH_GAME, 'crash.html');
    const ctx = makeCtx();
    const { contextAssembly, runFinalizer, toolCall, toolResult } = makeHarness(filePath, CRASH_GAME);

    await handleModifiedArtifactValidation({
      ctx,
      contextAssembly,
      runFinalizer: runFinalizer as RunFinalizer,
      toolCall,
      normalizedSuccess: true,
      toolResult,
      artifactRepairRollbackSnapshot: null,
    });

    const metadata = toolResult.metadata as { artifactValidation?: { playabilitySmoke?: { skipped?: boolean } } } | undefined;
    if (metadata?.artifactValidation?.playabilitySmoke?.skipped) return; // Playwright 不可用环境按 skipped 放过

    expect(toolResult.success).toBe(false);
    expect(String(toolResult.error)).toContain('runtime page errors');
    expect(ctx.artifact.repairGuard).toMatchObject({ targetFile: filePath, attempts: 1 });
    expect((runFinalizer as unknown as { emitTaskProgress: ReturnType<typeof vi.fn> }).emitTaskProgress)
      .toHaveBeenCalledWith('tool_running', expect.stringContaining('第 1/4 次修复'));
  });

  // 任务面板的「当前动作」行原样显示 emitTaskProgress 的文案：切换重写那条曾把内部原因
  // （失败码 run_smoke_failed/…、patience 耗尽、补丁抗性）直接拼进去。原因只留给模型和日志。
  it('switching to a fresh rewrite tells the user in plain words; the internal reason stays model-only', async () => {
    const filePath = await writeTempHtml(CRASH_GAME, 'crash-rewrite.html');
    const ctx = makeCtx();
    // 上一轮已失败过且没刷新最佳成绩：这一轮再失败 = patience 用完 → 切换重写。
    ctx.artifact.validationFailures.set(filePath, {
      attempts: 1,
      phase: 'baseline_repair',
      bestFailureCount: 1,
      roundsSinceBest: 1,
    });
    const { contextAssembly, runFinalizer, toolCall, toolResult } = makeHarness(filePath, CRASH_GAME);

    await handleModifiedArtifactValidation({
      ctx,
      contextAssembly,
      runFinalizer: runFinalizer as RunFinalizer,
      toolCall,
      normalizedSuccess: true,
      toolResult,
      artifactRepairRollbackSnapshot: null,
    });

    const metadata = toolResult.metadata as { artifactValidation?: { playabilitySmoke?: { skipped?: boolean } } } | undefined;
    if (metadata?.artifactValidation?.playabilitySmoke?.skipped) return; // Playwright 不可用环境按 skipped 放过

    expect(ctx.artifact.validationFailures.get(filePath)).toMatchObject({ phase: 'fresh_rewrite', rewriteAttempted: true });
    const steps = (runFinalizer as unknown as { emitTaskProgress: ReturnType<typeof vi.fn> }).emitTaskProgress
      .mock.calls.map((call) => String(call[1]));
    expect(steps).toContain('几轮修复没有进展，改为重新生成…');
    // 这一轮发给界面的每条进度都不带英文内部词、失败码或内部术语。
    for (const step of steps) {
      expect(step, step).not.toMatch(/[A-Za-z_]/);
      expect(step, step).not.toMatch(/补丁|不收敛|抗性|失败码/);
    }
    // 原因仍然给到模型（注入的系统消息），没有被一起删掉。
    const injected = (contextAssembly as unknown as { injectSystemMessage: ReturnType<typeof vi.fn> }).injectSystemMessage
      .mock.calls.map((call) => String(call[0])).join('\n');
    expect(injected).toContain('<artifact-fresh-rewrite>');
    expect(injected).toContain('patience 耗尽');
  });

  // B7 P1 接线契约：ctx.scaffoldProfile.repairInstructionStyle 必须真传进
  // buildArtifactRepairInstruction——摘掉 lifecycle 的 style 实参本测必红。
  it('injects the compact repair instruction when ctx.scaffoldProfile says compact', async () => {
    const filePath = await writeTempHtml(CRASH_GAME, 'crash-compact.html');
    const ctx = makeCtx({
      scaffoldProfile: {
        tier: 'strong',
        thinkingInjection: false,
        auditNudgeIntervalMultiplier: 2,
        repairInstructionStyle: 'compact',
      },
    } as Partial<RuntimeContext>);
    const { contextAssembly, runFinalizer, toolCall, toolResult } = makeHarness(filePath, CRASH_GAME);

    await handleModifiedArtifactValidation({
      ctx,
      contextAssembly,
      runFinalizer: runFinalizer as RunFinalizer,
      toolCall,
      normalizedSuccess: true,
      toolResult,
      artifactRepairRollbackSnapshot: null,
    });

    const metadata = toolResult.metadata as { artifactValidation?: { playabilitySmoke?: { skipped?: boolean } } } | undefined;
    if (metadata?.artifactValidation?.playabilitySmoke?.skipped) return; // Playwright 不可用环境按 skipped 放过

    expect(toolResult.success).toBe(false);
    const inject = (contextAssembly as unknown as { injectSystemMessage: ReturnType<typeof vi.fn> }).injectSystemMessage;
    expect(inject).toHaveBeenCalled();
    const injected = inject.mock.calls.map((call) => String(call[0])).join('\n');
    expect(injected).toContain('直接对目标文件做最小修复');
    // full 版首轮尾部话术不得出现（出现 = style 没接进去，走了 full 模板）
    expect(injected).not.toContain('优先依据失败摘要直接修改目标文件');
    // 机器可读 spec 不内联进 compact 注入，但仍随 toolResult.error 返回，模型不丢 spec
    expect(injected).not.toContain('<artifact_repair_spec>');
    expect(String(toolResult.error)).toContain('artifact_repair_spec');
  });

  it('passes a healthy game on the light path and records the pass marker', async () => {
    const filePath = await writeTempHtml(HEALTHY_GAME, 'healthy.html');
    const ctx = makeCtx();
    const { contextAssembly, runFinalizer, toolCall, toolResult } = makeHarness(filePath, HEALTHY_GAME);

    await handleModifiedArtifactValidation({
      ctx,
      contextAssembly,
      runFinalizer: runFinalizer as RunFinalizer,
      toolCall,
      normalizedSuccess: true,
      toolResult,
      artifactRepairRollbackSnapshot: null,
    });

    expect(toolResult.success).toBe(true);
    expect(ctx.artifact.repairGuard).toBeUndefined();
    expect(ctx.artifact.validationPassedTargetFile).toBe(filePath);
  });
});

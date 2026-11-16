// ============================================================================
// 并行 Agent Team 完成路径（spawn_agent → onTaskComplete）把成员真实写过的文件
// 写进 swarm:agent:completed 事件与持久化账本 files_changed_json。
// ============================================================================
// 真 launchAgentTeam → 真 ParallelAgentCoordinator → 真 SubagentExecutor → 真 Write 工具，
// 假点只有本地假模型 HTTP 服务；账本是真 SwarmTraceWriter + 内存 sqlite。
// ============================================================================
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

import type { SwarmEvent } from '../../../src/shared/contract/swarm';

let root: string;
let cwd: string;
let registry: ReturnType<typeof import('../../../src/host/tools/protocolRegistry').getProtocolRegistry>;
let launchAgentTeam: typeof import('../../../src/host/agent/multiagentTools/spawnAgent').launchAgentTeam;
let SwarmTraceWriter: typeof import('../../../src/host/agent/swarmTraceWriter').SwarmTraceWriter;
let SwarmTraceRepository: typeof import('../../../src/host/services/core/repositories/SwarmTraceRepository').SwarmTraceRepository;
let configureAgentTeamDurableRuntime: typeof import('../../../src/host/agent/agentTeamDurableAdapter').configureAgentTeamDurableRuntime;
let AgentTeamDurableRuntime: typeof import('../../../src/host/agent/agentTeamDurableAdapter').AgentTeamDurableRuntime;
let DurableRunKernel: typeof import('../../../src/host/runtime/durableRunKernel').DurableRunKernel;
let DurableRunRepository: typeof import('../../../src/host/services/core/repositories/DurableRunRepository').DurableRunRepository;
let appRuns: typeof import('../../../src/host/app/applicationRunRegistry');
let getEventBus: typeof import('../../../src/host/services/eventing/bus').getEventBus;
let shutdownEventBus: typeof import('../../../src/host/services/eventing/bus').shutdownEventBus;

/** 假模型：提示里出现哪个文件名就写哪个文件；mode=read 时只读不写。 */
function startScriptedModel(): Promise<{ url: string; close(): Promise<void> }> {
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += String(chunk); });
      req.on('end', () => {
        const toolDone = body.includes('"role":"tool"');
        const target = body.includes('kickoff.md') ? 'kickoff.md' : 'risks.md';
        const message = toolDone
          ? { role: 'assistant', content: `STATUS: wrote ${target}` }
          : {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call_1', type: 'function',
                function: { name: 'Write', arguments: JSON.stringify({ file_path: path.join(cwd, target), content: `# ${target}\n` }) },
              }],
            };
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          id: 'scripted', object: 'chat.completion', created: 1, model: 'glm-5.3',
          choices: [{ index: 0, message, finish_reason: toolDone ? 'stop' : 'tool_calls' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('no port');
      resolve({
        url: `http://127.0.0.1:${address.port}/v4`,
        close: () => new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); }),
      });
    });
  });
}

function createSchema(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE swarm_runs (
      id TEXT PRIMARY KEY, session_id TEXT, coordinator TEXT NOT NULL, status TEXT NOT NULL,
      started_at INTEGER NOT NULL, ended_at INTEGER, total_agents INTEGER NOT NULL DEFAULT 0,
      completed_count INTEGER NOT NULL DEFAULT 0, failed_count INTEGER NOT NULL DEFAULT 0,
      parallel_peak INTEGER NOT NULL DEFAULT 0, total_tokens_in INTEGER NOT NULL DEFAULT 0,
      total_tokens_out INTEGER NOT NULL DEFAULT 0, total_tool_calls INTEGER NOT NULL DEFAULT 0,
      total_cost_usd REAL NOT NULL DEFAULT 0, trigger TEXT NOT NULL DEFAULT 'unknown',
      error_summary TEXT, aggregation_json TEXT, tags_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE swarm_run_agents (
      run_id TEXT NOT NULL, agent_id TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL, start_time INTEGER, end_time INTEGER, duration_ms INTEGER,
      tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
      tool_calls INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0, error TEXT, failure_category TEXT,
      files_changed_json TEXT NOT NULL DEFAULT '[]', dispatched_task TEXT, dispatched_task_truncated INTEGER,
      dispatched_task_archive_item_id TEXT, final_output TEXT, final_output_truncated INTEGER,
      final_output_archive_item_id TEXT,
      PRIMARY KEY (run_id, agent_id),
      FOREIGN KEY (run_id) REFERENCES swarm_runs(id) ON DELETE CASCADE
    );
    CREATE TABLE swarm_run_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, seq INTEGER NOT NULL, timestamp INTEGER NOT NULL,
      event_type TEXT NOT NULL, agent_id TEXT, level TEXT NOT NULL DEFAULT 'info', title TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '', payload_json TEXT,
      FOREIGN KEY (run_id) REFERENCES swarm_runs(id) ON DELETE CASCADE
    );
  `);
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'spawn-files-changed-'));
  cwd = path.join(root, 'work');
  await mkdir(path.join(root, 'data'), { recursive: true });
  await mkdir(cwd, { recursive: true });
  vi.stubEnv('CODE_AGENT_HOME', root);
  vi.stubEnv('CODE_AGENT_DATA_DIR', path.join(root, 'data'));
  vi.stubEnv('CODE_AGENT_LOG_DIR', path.join(root, 'logs'));
  registry = (await import('../../../src/host/tools/protocolRegistry')).getProtocolRegistry();
  ({ launchAgentTeam } = await import('../../../src/host/agent/multiagentTools/spawnAgent'));
  ({ SwarmTraceWriter } = await import('../../../src/host/agent/swarmTraceWriter'));
  ({ SwarmTraceRepository } = await import('../../../src/host/services/core/repositories/SwarmTraceRepository'));
  ({ configureAgentTeamDurableRuntime, AgentTeamDurableRuntime } = await import('../../../src/host/agent/agentTeamDurableAdapter'));
  ({ DurableRunKernel } = await import('../../../src/host/runtime/durableRunKernel'));
  ({ DurableRunRepository } = await import('../../../src/host/services/core/repositories/DurableRunRepository'));
  appRuns = await import('../../../src/host/app/applicationRunRegistry');
  const { DatabaseService } = await import('../../../src/host/services/core/databaseService');
  // 持久化原生工具检查点只需要一条父会话的用户消息 id；其余走真实链路。
  vi.spyOn(DatabaseService.prototype, 'getMessages').mockReturnValue([{ id: 'files-ledger-user-msg', role: 'user' }] as never);
  ({ getEventBus, shutdownEventBus } = await import('../../../src/host/services/eventing/bus'));
}, 60_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe.sequential('Agent Team 完成账本 filesChanged', () => {
  let db: BetterSqlite3.Database;
  let repo: InstanceType<typeof SwarmTraceRepository>;
  let writer: InstanceType<typeof SwarmTraceWriter>;
  const completed: SwarmEvent[] = [];
  let unsubscribe: (() => void) | undefined;

  beforeEach(() => {
    db = new Database(':memory:');
    createSchema(db);
    repo = new SwarmTraceRepository(db);
    writer = new SwarmTraceWriter(repo, { defaultTrigger: 'llm-spawn', defaultCoordinator: 'hybrid' });
    writer.install();
    const durableDb = new Database(':memory:');
    durableDb.pragma('foreign_keys = ON');
    const durableRepo = new DurableRunRepository(durableDb);
    durableRepo.migrate();
    const kernel = new DurableRunKernel({ stores: durableRepo, ownerId: 'host', processInstanceId: 'files-ledger', leaseDurationMs: 60_000 });
    const registry = appRuns.getApplicationRunRegistry();
    registry.configureDurableKernel(kernel);
    configureAgentTeamDurableRuntime(new AgentTeamDurableRuntime(kernel, registry));
    completed.length = 0;
    unsubscribe = getEventBus().subscribe('swarm', (event: { data?: unknown }) => {
      const payload = event.data as SwarmEvent | undefined;
      if (payload?.type === 'swarm:agent:completed') completed.push(payload);
    }) as unknown as () => void;
  });

  afterEach(async () => {
    unsubscribe?.();
    configureAgentTeamDurableRuntime(null);
    appRuns.resetApplicationRunRegistryForTests();
    await writer.dispose();
    db.close();
    shutdownEventBus();
  });

  it('两个写文件的成员完成后，事件与 files_changed_json 都带真实路径', async () => {
    const fake = await startScriptedModel();
    await appRuns.getApplicationRunRegistry().startDurable({ runId: 'files-ledger-native-run', sessionId: 'files-ledger-session', workspace: cwd });
    try {
      const result = await launchAgentTeam([
        { role: 'coder', name: 'a', task: 'Write the project kickoff checklist to kickoff.md' },
        { role: 'coder', name: 'b', task: 'Write the risk list to risks.md' },
      ], {
        sessionId: 'files-ledger-session',
        runId: 'files-ledger-native-run',
        currentToolCallId: 'files-ledger-call',
        cwd,
        workspace: cwd,
        modelConfig: { provider: 'zhipu', model: 'glm-5.3', apiKey: 'scripted-test-key', baseUrl: fake.url, temperature: 0 },
        resolver: {
          getDefinition: (name: string) => {
            const schema = registry.getSchemas().find((candidate) => candidate.name === name);
            return schema ? {
              name: schema.name, description: schema.description, inputSchema: schema.inputSchema,
              outputSchema: schema.outputSchema, requiresPermission: schema.requiresPermission ?? false,
              permissionLevel: schema.permissionLevel === 'dangerous' ? 'execute' : schema.permissionLevel,
              readOnly: schema.readOnly, touchesWorkDirectory: schema.touchesWorkDirectory,
            } : undefined;
          },
        },
        permission: { request: async () => true },
        events: { emit: () => {} },
        abortSignal: new AbortController().signal,
      } as never);
      expect(result.error ?? '').toBe('');
      expect(result.success).toBe(true);
    } finally {
      await fake.close();
    }
    await writer.drain();

    const eventFiles = completed.map((e) => e.data?.agentState?.filesChanged ?? []).flat().sort();
    expect(eventFiles).toEqual([path.join(cwd, 'kickoff.md'), path.join(cwd, 'risks.md')].sort());

    const rows = db.prepare('SELECT agent_id, status, files_changed_json FROM swarm_run_agents').all() as Array<{ status: string; files_changed_json: string }>;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBe('completed');
      expect(JSON.parse(row.files_changed_json)).toHaveLength(1);
    }
  }, 60_000);
});

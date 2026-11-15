#!/usr/bin/env node
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const requireFromRepo = createRequire(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../package.json'),
);
const { Server } = await import(requireFromRepo.resolve('@modelcontextprotocol/server'));
const { serveStdio } = await import(requireFromRepo.resolve('@modelcontextprotocol/server/stdio'));

const defaultHomeDir = os.homedir();
const logPath = process.env.FAKE_CUA_DRIVER_JSONL
  || path.join(defaultHomeDir, '.code-agent', 'fake-cua-driver.jsonl');
const stateFile = process.env.FAKE_CUA_DRIVER_STATE_FILE
  || path.join(defaultHomeDir, '.code-agent', 'fake-cua-driver-state.json');

function readDynamicState() {
  if (!stateFile || !existsSync(stateFile)) return null;
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch {
    return null;
  }
}

function recordCall(toolName, args) {
  if (!logPath) return;
  mkdirSync(path.dirname(logPath), { recursive: true });
  const entry = {
    ts: Date.now(),
    iso: new Date().toISOString(),
    pid: process.pid,
    toolName,
    args: args ?? {},
  };
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`, 'utf8');
}

const MUTATION_TOOLS = [
  'click',
  'double_click',
  'right_click',
  'set_value',
  'type_text',
  'press_key',
  'hotkey',
  'scroll',
  'drag',
];

const ALL_TOOLS = [
  'start_session',
  'end_session',
  'list_windows',
  'get_window_state',
  ...MUTATION_TOOLS,
];

let observation = 0;

const server = new Server(
  { name: 'cua-driver-fake', version: '0.14.2' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler('tools/list', async () => ({
  tools: ALL_TOOLS.map((name) => ({
    name,
    description: `Fake cua-driver tool: ${name}`,
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: true,
    },
  })),
}));

server.setRequestHandler('tools/call', async (request) => {
  const toolName = String(request.params?.name ?? '');
  const args = (request.params?.arguments && typeof request.params.arguments === 'object')
    ? request.params.arguments
    : {};

  if (toolName === 'start_session' || toolName === 'end_session') {
    recordCall(toolName, args);
    const structured = { ok: true, session: args.session ?? null };
    return {
      content: [{ type: 'text', text: JSON.stringify(structured) }],
      structuredContent: structured,
    };
  }

  if (toolName === 'list_windows') {
    recordCall('list_windows', args);
    const dyn = readDynamicState();
    const structured = {
      windows: dyn?.windows ?? [
        {
          pid: 42,
          window_id: 7,
          app_name: 'Notes',
          title: dyn?.windowTitle ?? 'Weekly report',
          is_on_screen: true,
          on_current_space: true,
        },
      ],
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(structured) }],
      structuredContent: structured,
    };
  }

  if (toolName === 'get_window_state') {
    observation += 1;
    recordCall('get_window_state', { ...args, _observationSeq: observation });
    const dyn = readDynamicState();
    const phase = dyn?.phase ?? (observation > 1 ? 'unlocked' : 'login_dialog');
    const elements = phase === 'login_dialog'
      ? [
          {
            element_index: 1,
            element_token: `token-${observation}-1`,
            role: 'AXStaticText',
            label: 'iCloud Sign-In Dialog — Verification required before editing Notes',
            frame: { x: 10, y: 10, w: 180, h: 24 },
          },
          {
            element_index: 2,
            element_token: `token-${observation}-2`,
            role: 'AXButton',
            label: 'Sign in',
            frame: { x: 10, y: 40, w: 80, h: 24 },
          },
        ]
      : [
          {
            element_index: 1,
            element_token: `token-${observation}-1`,
            role: 'AXTextArea',
            label: 'Weekly report body',
            value: dyn?.noteBody ?? '',
            frame: { x: 10, y: 10, w: 180, h: 70 },
          },
          {
            element_index: 2,
            element_token: `token-${observation}-2`,
            role: 'AXButton',
            label: 'Continue after login',
            frame: { x: 10, y: 82, w: 120, h: 16 },
          },
        ];
    const structured = {
      snapshot_id: `snapshot-${observation}`,
      screenshot_width: 200,
      screenshot_height: 100,
      elements,
    };
    const screenshotBase64 = Buffer.from(`screen-${observation}-${phase}`).toString('base64');
    return {
      content: [
        { type: 'text', text: JSON.stringify(structured) },
        { type: 'image', data: screenshotBase64, mimeType: 'image/png' },
      ],
      structuredContent: structured,
    };
  }

  if (MUTATION_TOOLS.includes(toolName)) {
    recordCall(toolName, args);
    return {
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { ok: true, tool: toolName },
    };
  }

  recordCall(`unknown:${toolName}`, args);
  return {
    isError: true,
    content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
  };
});

serveStdio(() => server);

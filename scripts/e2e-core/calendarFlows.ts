// 挂靠 Dev 槽（--slot N）跑日历主路径 F01-F04：卡片见 docs/e2e/feature-map.md。
// 这四条走原生 EventKit，只在打包壳里有真实现（src/host/connectors/native/calendar.ts），
// 所以不进 CORE_FLOWS（夜间隔离 web 服务跑不了），也不动 flows.ts 的 SHELL_WEB_FLOWS 归属。
// 前提与安全护栏（本单任务书）：
//  - step 0 探针：NEO_E2E_CALENDAR 未设或日历连接器不是完全访问，红在 step 0、不再跑任何步骤；
//  - 每次尝试一个运行标记（E2E-<6 hex>），所有用户请求点名专属日历并要求标题带标记；
//  - 每个写步骤之后读库核对：calendar_create_event / calendar_update_event 的参数（messages.tool_calls）
//    一旦指向别的日历或缺标记立即红（事件状态取自 tool_execution_events）；
//  - cleanup 经同一聊天 + 删除审批卡清掉本标记的全部事件，再用读核对残留，残留写进 result reason。
import type { Page } from 'playwright';
import { describeRows, expectDb, family, inSessions, lastAssistantText } from './db';
import type { AttemptEnv, DbSnapshot, FlowDef, ServerInfo } from './types';
import { currentPermissionCard, driveTurn, openNewSession, sendMessage, sleep, waitFor } from './ui';

const TURN_TIMEOUT_MS = 240_000;
const CARD_TIMEOUT_MS = 120_000;
const WRITE_CHECK_TIMEOUT_MS = 90_000;

const CALENDAR_ENV_VAR = 'NEO_E2E_CALENDAR';
const NO_CALENDAR_STEP_TEXT = 'precondition: no dedicated calendar (NEO_E2E_CALENDAR)';
const UNAUTHORIZED_STEP_TEXT = '前置：日历未授权';

/** create/update 之外的读工具不在护栏范围；delete 由 cleanup 的读核对兜底。 */
const WRITE_TOOLS = ['calendar_create_event', 'calendar_update_event'];
/** 不经审批卡就走不了的写回卡按钮：文案见 src/renderer/i18n/decisionCard.ts。 */
const CREATE_BUTTON = '创建';
const UPDATE_BUTTON = '更新';
const DELETE_BUTTON = '删除';

type CardLocator = NonNullable<Awaited<ReturnType<typeof currentPermissionCard>>>;

function calendarOf(env: AttemptEnv): string {
  const v = env.scratch.calendar;
  if (typeof v !== 'string' || !v) throw new Error('专属日历名不在本次尝试的 scratch 里（step 0 探针没有先跑）');
  return v;
}

function markerOf(env: AttemptEnv): string {
  const v = env.scratch.marker;
  if (typeof v !== 'string' || !v) throw new Error('运行标记不在本次尝试的 scratch 里（step 0 探针没有先跑）');
  return v;
}

// ── step 0：日历授权探针 ────────────────────────────────────────────────────

/** POST /api/domain/connector/listStatuses（src/web/routes/domain.ts）——授权真源就是连接器状态。 */
async function connectorStatuses(server: { port: number; token: string }): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`http://127.0.0.1:${server.port}/api/domain/connector/listStatuses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json().catch(() => null) as { success?: boolean; data?: unknown } | null;
  const list = body && typeof body === 'object' && 'data' in body ? body.data : body;
  return Array.isArray(list) ? list as Array<Record<string, unknown>> : [];
}

/** 完全访问 = 连接器在线且 ready（src/host/connectors/native/calendar.ts：granted → readiness/detailCode 'ready'）。 */
function isFullAccess(status: Record<string, unknown>): boolean {
  return status.connected === true && status.readiness === 'ready' && status.detailCode === 'ready';
}

/**
 * step 0：任何消息都没发之前先验前提。NEO_E2E_CALENDAR 未设 → 红在「没有专属日历」；
 * 日历连接器不是完全访问 → 红在「日历未授权」，原始状态 JSON 挂到 reason。
 * 日历名与运行标记只在授权通过后才写进 scratch——step 0 红（含未授权）时 cleanup 看不到它们，
 * 不会在红了之后又发任何消息。
 */
async function probeCalendar(env: AttemptEnv): Promise<void> {
  const calendar = process.env[CALENDAR_ENV_VAR]?.trim();
  if (!calendar) throw new Error(NO_CALENDAR_STEP_TEXT);
  const statuses = await connectorStatuses(env.server);
  const calendarStatus = statuses.find((s) => s.id === 'calendar');
  if (!calendarStatus || !isFullAccess(calendarStatus)) {
    env.note(`日历连接器原始状态：${JSON.stringify(statuses)}`);
    throw new Error(UNAUTHORIZED_STEP_TEXT);
  }
  env.scratch.calendar = calendar;
  env.scratch.marker = `E2E-${Math.random().toString(16).slice(2, 8)}`;
  env.note(`step 0 授权探针通过：专属日历「${calendar}」完全访问，本次运行标记 ${markerOf(env)}`);
}

// ── 写安全护栏：参数来自 messages.tool_calls，状态来自 tool_execution_events ──

interface WriteCall {
  tool: string;
  callId: string;
  args: Record<string, unknown>;
  phase: string | null;
  status: string | null;
}

function collectWriteCalls(data: DbSnapshot, ids: string[]): WriteCall[] {
  const events = new Map<string, { phase: unknown; status: unknown }>();
  for (const e of inSessions(data.toolEvents, ids)) {
    const callId = String(e.tool_call_id ?? '');
    if (callId && WRITE_TOOLS.includes(String(e.tool_name))) events.set(callId, { phase: e.phase, status: e.status });
  }
  const calls: WriteCall[] = [];
  for (const m of inSessions(data.messages, ids)) {
    let parsed: unknown;
    try { parsed = JSON.parse(String(m.tool_calls ?? '')); } catch { continue; }
    if (!Array.isArray(parsed)) continue;
    for (const tc of parsed as Array<Record<string, unknown>>) {
      if (!WRITE_TOOLS.includes(String(tc.name))) continue;
      const event = events.get(String(tc.id ?? ''));
      calls.push({
        tool: String(tc.name),
        callId: String(tc.id ?? ''),
        args: (tc.arguments && typeof tc.arguments === 'object' ? tc.arguments : {}) as Record<string, unknown>,
        phase: event ? String(event.phase) : null,
        status: event ? String(event.status) : null,
      });
    }
  }
  return calls;
}

/** 违规逐条列出：create 的 calendar 必须点名专属日历（缺省=第一个可写日历，不算过）；title 出现且必须带标记。 */
function writeViolations(calls: WriteCall[], calendar: string, marker: string): string[] {
  return calls.flatMap((c) => {
    const problems: string[] = [];
    const target = c.args.calendar;
    if (target !== calendar) problems.push(`calendar 参数应为「${calendar}」，实际是 ${JSON.stringify(target)}`);
    const title = c.args.title;
    if (typeof title === 'string' && !title.includes(marker)) problems.push(`标题缺运行标记 ${marker}：${JSON.stringify(title)}`);
    if (c.tool === 'calendar_create_event' && typeof title !== 'string') problems.push(`create 缺 title 参数，没法核对标记：${JSON.stringify(title)}`);
    return problems.length ? [`${c.tool}（call ${c.callId || '无 id'}，事件 ${c.phase ?? '-'}${c.status ? `/${c.status}` : ''}）：${problems.join('；')}`] : [];
  });
}

/**
 * 写步骤后的核对：违规立即红（不等轮询）；要等的只有「预期的 complete success / 审批 allow」。
 * expectTool 为 null 时只查违规（F03 的删除 + 撤销那步：删除不是 create/update，不进违规清单）。
 */
async function checkCalendarWrites(env: AttemptEnv, expectTool: string | null): Promise<void> {
  const calendar = calendarOf(env);
  const marker = markerOf(env);
  const deadline = Date.now() + WRITE_CHECK_TIMEOUT_MS;
  for (;;) {
    const { data, file } = await env.readDb();
    const ids = family(data, env.sessionIds);
    const calls = collectWriteCalls(data, ids);
    const problems = writeViolations(calls, calendar, marker);
    if (problems.length) throw new Error(`日历写安全护栏：有写调用越出专属日历或缺运行标记（快照 ${file}）：\n${problems.join('\n')}`);
    if (expectTool) {
      const mine = inSessions(data.toolEvents, ids).filter((e) => e.tool_name === expectTool);
      const allow = inSessions(data.permissionDecisions, ids).some((r) => r.tool_name === expectTool && r.final_outcome === 'allow');
      const done = mine.some((e) => e.phase === 'begin') && mine.some((e) => e.phase === 'complete' && e.status === 'success');
      if (done && allow) return;
      if (Date.now() > deadline) {
        const detail = !done
          ? `没有等到 ${expectTool} 的 begin + complete success：\n${describeRows(mine, ['tool_name', 'phase', 'status'])}`
          : `没有等到 ${expectTool} 的 allow 审批记录：\n${describeRows(inSessions(data.permissionDecisions, ids).filter((r) => r.tool_name === expectTool), ['tool_name', 'final_outcome', 'history_outcome', 'reason'])}`;
        throw new Error(`等待 ${expectTool} 超时（${WRITE_CHECK_TIMEOUT_MS / 1000}s，快照 ${file}）：${detail}`);
      }
    } else {
      return;
    }
    await sleep(2_000);
  }
}

// ── 写回卡（日历）的点击：不是普通卡的「允许 / 暂不」，按钮是 创建 / 更新 / 删除 ──

/** 点写回卡的确认按钮并等卡片收起或换阶段；文字完全匹配，避免「创建」撞上「修改后创建」。 */
async function clickWritebackButton(page: Page, label: string): Promise<void> {
  const card = await currentPermissionCard(page);
  if (!card) throw new Error(`点「${label}」前审批卡已离开页面`);
  const before = await card.innerText({ timeout: 10_000 });
  await card.getByRole('button', { name: label, exact: true }).click({ timeout: 10_000 });
  await waitFor(`点「${label}」后卡片收起`, async () => {
    if (!(await card.isVisible().catch(() => false))) return true;
    return (await card.innerText({ timeout: 10_000 }).catch(() => before)) !== before;
  }, 30_000);
}

/** 等审批卡出现并解析到具体请求；回合都收尾了还没卡就是模型没走审批（红）。 */
async function waitForCard(page: Page, what: string): Promise<CardLocator> {
  const card = page.getByTestId('permission-card').first();
  await driveTurn(page, { until: async () => card.isVisible() }, CARD_TIMEOUT_MS);
  if (!(await card.isVisible().catch(() => false))) throw new Error(`${what}：回合收尾了也没有出现审批卡 permission-card`);
  return await currentPermissionCard(page) ?? card;
}

/** 点确认按钮后等回合收尾；期间再冒出的同类卡继续点同一颗按钮。 */
async function approveAndSettle(env: AttemptEnv, label: string): Promise<void> {
  await clickWritebackButton(env.page, label);
  await driveTurn(env.page, { mayBeIdle: true, onPermissionCard: () => clickWritebackButton(env.page, label) }, TURN_TIMEOUT_MS);
}

// ── F02 / F03 的前置事件：经同一聊天 + 审批路径先创建本标记的事件 ──

async function createMarkedEvent(env: AttemptEnv, when: string): Promise<void> {
  const calendar = calendarOf(env);
  const marker = markerOf(env);
  env.sessionIds.push(await openNewSession(env.page));
  await sendMessage(env.page, `在日历「${calendar}」里建一个日程：标题设为「${marker} 评审会」，时间${when}下午三点。`);
  await waitForCard(env.page, `建前置事件（${marker} 评审会）`);
  await approveAndSettle(env, CREATE_BUTTON);
  // 前置创建也是一次写：立即过一遍同一道护栏，不等到最后的核对步骤
  await checkCalendarWrites(env, 'calendar_create_event');
}

// ── cleanup：经聊天 + 删除审批卡清掉本标记的全部事件，再用读核对残留 ──

function toolResultTexts(raw: string): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((r) => (r && typeof r === 'object' && typeof (r as { output?: unknown }).output === 'string' ? (r as { output: string }).output : ''))
    .filter(Boolean);
}

async function cleanupMarkedEvents(_server: ServerInfo, env?: AttemptEnv): Promise<void> {
  if (!env) return;
  const calendar = typeof env.scratch.calendar === 'string' ? env.scratch.calendar : '';
  const marker = typeof env.scratch.marker === 'string' ? env.scratch.marker : '';
  // step 0 就红了（没日历名 / 没标记）：本次尝试没发过任何消息，更没写过事件，无事可清
  if (!calendar || !marker) return;
  env.sessionIds.push(await openNewSession(env.page));
  await sendMessage(env.page, `在日历「${calendar}」里把标题带「${marker}」的日程都删掉。`);
  await driveTurn(env.page, { mayBeIdle: true, onPermissionCard: () => clickWritebackButton(env.page, DELETE_BUTTON) }, TURN_TIMEOUT_MS);
  await sendMessage(env.page, `在日历「${calendar}」里查标题带「${marker}」的日程，一条一条列出标题；没有就明说没有。`);
  const readAtMs = Date.now();
  await driveTurn(env.page, { mayBeIdle: true }, TURN_TIMEOUT_MS);
  const { data, file } = await env.readDb();
  // 只看读回合之后落库的工具结果（删除回合的结果会复述标题，不算残留）
  const afterRead = inSessions(data.messages, env.sessionIds).filter((m) => Number(m.timestamp) >= readAtMs - 2_000);
  const leftovers = afterRead.flatMap((m) => toolResultTexts(String(m.tool_results ?? ''))).filter((text) => text.includes(marker));
  if (leftovers.length) throw new Error(`cleanup 后日历里仍有带 ${marker} 的日程（快照 ${file}）：${leftovers.map((t) => t.slice(0, 160)).join(' | ')}`);
}

// ── 四条流程 ────────────────────────────────────────────────────────────────

const f01: FlowDef = {
  id: 'F01',
  title: '新建日程（自然语言 + 写入审批）',
  probe: probeCalendar,
  cleanup: cleanupMarkedEvents,
  steps: [
    {
      text: '在输入框说「明天下午三点帮我约个评审会」并发送。',
      run: async (env) => {
        env.sessionIds.push(await openNewSession(env.page));
        const calendar = calendarOf(env);
        const marker = markerOf(env);
        await sendMessage(env.page, `在日历「${calendar}」里帮我建一个日程：明天下午三点约个评审会，标题设为「${marker} 评审会」。`);
      },
    },
    {
      text: '出现审批卡，核对时间 / 标题。',
      run: async (env) => {
        const card = await waitForCard(env.page, '新建日程审批卡');
        const text = await card.innerText({ timeout: 10_000 });
        if (!text.includes(markerOf(env))) throw new Error(`审批卡上没有本次运行标记的标题（应含 ${markerOf(env)}）：${text.slice(0, 200)}`);
        if (!/(15:00|下午|三点)/.test(text)) throw new Error(`审批卡上没有下午三点的时间语义：${text.slice(0, 200)}`);
      },
    },
    {
      text: '点「创建」。',
      run: (env) => approveAndSettle(env, CREATE_BUTTON),
    },
    {
      text: '核对可观测量：calendar_create_event 的 begin + complete success、审批 allow；写调用只落在专属日历、标题带运行标记。',
      run: async (env) => {
        await checkCalendarWrites(env, 'calendar_create_event');
        const { data, file } = await env.readDb();
        const reply = lastAssistantText(data, env.sessionIds);
        if (!reply) throw new Error(`回合结束后没有助手回复文字（快照 ${file}）`);
      },
    },
  ],
};

const f02: FlowDef = {
  id: 'F02',
  title: '修改日程',
  probe: probeCalendar,
  cleanup: cleanupMarkedEvents,
  steps: [
    {
      text: '说「把评审会改到四点」。',
      run: async (env) => {
        // 前置：日历里已有带本次运行标记的评审会（卡片 Preconditions）——经同一聊天 + 审批路径先创建
        await createMarkedEvent(env, '明天');
        await sendMessage(env.page, `把日历「${calendarOf(env)}」里标题带「${markerOf(env)}」的评审会改到四点。`);
      },
    },
    {
      text: '审批卡点「更新」。',
      run: async (env) => {
        await waitForCard(env.page, '更新日程审批卡');
        await approveAndSettle(env, UPDATE_BUTTON);
      },
    },
    {
      text: '核对可观测量：calendar_update_event complete success；写调用只落在专属日历、标题带运行标记；回复写明新时间。',
      run: async (env) => {
        await checkCalendarWrites(env, 'calendar_update_event');
        const { data, file } = await env.readDb();
        const reply = lastAssistantText(data, env.sessionIds);
        if (!reply) throw new Error(`回合结束后没有助手回复文字（快照 ${file}）`);
        if (!/(四点|16:00|4 点|4点)/.test(reply)) throw new Error(`回复没有写明新时间（四点）：${reply.slice(0, 160)}`);
      },
    },
  ],
};

const f03: FlowDef = {
  id: 'F03',
  title: '删除日程并撤销',
  probe: probeCalendar,
  cleanup: cleanupMarkedEvents,
  steps: [
    {
      text: '说「把明天的评审会删了」。',
      run: async (env) => {
        // 前置：日历里有一个带本次运行标记的事件（卡片 Preconditions）——经同一聊天 + 审批路径先创建
        await createMarkedEvent(env, '明天');
        await sendMessage(env.page, `把日历「${calendarOf(env)}」里标题带「${markerOf(env)}」的明天评审会删掉。`);
      },
    },
    {
      text: '审批卡点「删除」。',
      run: async (env) => {
        await waitForCard(env.page, '删除日程审批卡');
        await approveAndSettle(env, DELETE_BUTTON);
      },
    },
    {
      text: '回复里出现「撤销」按钮，点它。',
      run: async (env) => {
        const undo = env.page.getByTestId('calendar-delete-undo');
        await undo.waitFor({ state: 'visible', timeout: 30_000 });
        await undo.click({ timeout: 10_000 });
        await env.page.getByTestId('calendar-delete-undone').waitFor({ state: 'visible', timeout: 30_000 });
      },
    },
    {
      text: '核对可观测量：calendar_delete_event success、撤销为已恢复态且无失败提示；create/update 调用只落在专属日历、标题带运行标记。',
      run: async (env) => {
        await checkCalendarWrites(env, null);
        const { data, file } = await env.readDb();
        const ids = family(data, env.sessionIds);
        const deleted = inSessions(data.toolEvents, ids).some((e) => e.tool_name === 'calendar_delete_event' && e.phase === 'complete' && e.status === 'success');
        if (!deleted) throw new Error(`没有 calendar_delete_event 的 complete success（快照 ${file}）：\n${describeRows(inSessions(data.toolEvents, ids).filter((e) => String(e.tool_name).startsWith('calendar')), ['tool_name', 'phase', 'status'])}`);
        if (await env.page.getByTestId('calendar-delete-undo-failed').isVisible().catch(() => false)) throw new Error('撤销失败了（calendar-delete-undo-failed 出现）');
      },
    },
  ],
};

const f04: FlowDef = {
  id: 'F04',
  title: '查看日程',
  probe: probeCalendar,
  steps: [
    {
      text: '说「我这周日程怎么样」。',
      run: async (env) => {
        env.sessionIds.push(await openNewSession(env.page));
        await sendMessage(env.page, `看看日历「${calendarOf(env)}」里我这周日程怎么样。`);
      },
    },
    {
      text: '核对可观测量：calendar 只读 complete success、无 deny 审批、回复按天列出事件。',
      run: async (env) => {
        await expectDb(env, (d) => {
          const ids = family(d, env.sessionIds);
          const read = inSessions(d.toolEvents, ids).some((e) => e.tool_name === 'calendar' && e.phase === 'complete' && e.status === 'success');
          if (!read) return `没有 calendar 只读的 complete success：\n${describeRows(inSessions(d.toolEvents, ids).filter((e) => String(e.tool_name).startsWith('calendar')), ['tool_name', 'phase', 'status'])}`;
          const denied = inSessions(d.permissionDecisions, ids).some((r) => String(r.tool_name).startsWith('calendar') && r.final_outcome === 'deny');
          if (denied) return '只读日历却出现了 deny 审批记录';
          const reply = lastAssistantText(d, ids);
          if (!reply) return '回合结束后没有助手回复文字';
          return null;
        });
      },
    },
  ],
};

/** 挂靠模式（--slot）能跑的流程：只有日历四条，正文见 docs/e2e/feature-map.md 的对应卡片。 */
export const SLOT_FLOWS: FlowDef[] = [f01, f02, f03, f04];

export const SLOT_FLOW_IDS: string[] = SLOT_FLOWS.map((f) => f.id);

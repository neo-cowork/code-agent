// 隔离服务的 host HTTP 接口薄封装：流程模块里所有绕过页面的操作（建会话、种消息、
// 读写设置）都走这里，和页面用的是同一批 /api/* 入口，不另造协议。
import type { Message } from '../../src/shared/contract';

type Peer = { port: number; token: string };

async function call(server: Peer, method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    method,
    headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} 失败：HTTP ${res.status} ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

/** GET /api/settings（领域 settings.get 的直通返回）。 */
export async function getSettings(server: Peer): Promise<{ ui?: { language?: string } }> {
  return (await call(server, 'GET', '/api/settings')) as { ui?: { language?: string } };
}

/** PUT /api/settings：设置页「界面语言」按钮最终调的同一入口（ui.language 局部即可）。 */
export async function putSettings(server: Peer, patch: Record<string, unknown>): Promise<void> {
  await call(server, 'PUT', '/api/settings', patch);
}

/** POST /api/sessions：像用户把文件夹交给 Neo 一样建会话。 */
export async function createSession(server: Peer, title: string, workingDirectory?: string): Promise<string> {
  const body = (await call(server, 'POST', '/api/sessions', { title, ...(workingDirectory ? { workingDirectory } : {}) })) as
    { data?: { id?: string } };
  const id = body.data?.id;
  if (!id) throw new Error(`建会话失败：返回里没有 id（${JSON.stringify(body).slice(0, 200)}）`);
  return id;
}

/** POST /api/dev/seed-messages：把消息按真实持久化路径写进会话（同 tests/e2e 的用法）。 */
export async function seedMessages(server: Peer, sessionId: string, messages: Message[]): Promise<number> {
  const body = (await call(server, 'POST', '/api/dev/seed-messages', { sessionId, messages })) as { count?: number };
  return Number(body.count ?? 0);
}

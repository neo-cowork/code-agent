import { createSession, seedMessages } from './api';
import { expectDb, inSessions } from './db';
import type { Message } from '../../src/shared/contract';
import type { FlowDef, ServerInfo } from './types';
import { sleep } from './ui';

// 几十轮的旧会话：40 轮（80 条消息）用 dev 种子接口按真实持久化路径写入（同
// tests/e2e/chat-return-blank-log.spec.ts 的用法），页面侧只做用户动作：侧栏点开、滚动。
const TURNS = 40;
const TITLE = '项目进展复盘（长会话）';

function seedBatch(baseMs: number): Message[] {
  // messages.id 是全库主键：每次尝试换一个随机前缀，避免和上一次尝试种的消息撞 id
  const tag = Math.random().toString(36).slice(2, 8);
  const messages: Message[] = [];
  for (let turn = 1; turn <= TURNS; turn += 1) {
    messages.push(
      { id: `f16-${tag}-u${turn}`, role: 'user', content: `第 ${turn} 轮：这周项目进展怎么样，下一步做什么`, timestamp: baseMs + turn * 60_000 },
      {
        id: `f16-${tag}-a${turn}`, role: 'assistant',
        content: `第 ${turn} 轮回复：本周完成了长会话滚动定位的修复，视图稳定停在底部；下一轮继续核对第 ${turn + 1} 轮的问题。${'这一段是撑高度用的长回复正文，用来确认滚动位置真的落在最后一条消息上。'.repeat(8)}`,
        timestamp: baseMs + turn * 60_000 + 1_000,
      },
    );
  }
  return messages;
}

/** 用户视角的「旧会话已存在」：消息按真实持久化路径提前写进一条已有会话。 */
async function prepare(server: ServerInfo): Promise<void> {
  const id = await createSession(server, TITLE, server.workspace);
  const seeded = await seedMessages(server, id, seedBatch(Date.now() - TURNS * 60_000));
  if (seeded !== TURNS * 2) throw new Error(`种消息失败：写入 ${seeded} 条，应为 ${TURNS * 2}`);
}

export const f16: FlowDef = {
  id: 'F16',
  title: '重新打开一个很长的旧会话',
  prepare,
  steps: [
    {
      text: '在侧栏点这条会话。',
      run: async (env) => {
        const page = env.page;
        const item = page.locator('[data-session-id]').filter({ hasText: TITLE }).first();
        await item.waitFor({ state: 'visible', timeout: 30_000 });
        await item.click();
        const id = await item.getAttribute('data-session-id');
        if (id) env.sessionIds.push(id);
        // 会话内容完整出现：转写区出现轮次节点，且没有「加载失败」
        const log = page.locator('[data-trace-turn-id]');
        await log.first().waitFor({ state: 'visible', timeout: 30_000 });
        if (await page.getByTestId('session-load-error').isVisible().catch(() => false)) {
          throw new Error('打开会话出现了 session-load-error（加载失败）');
        }
      },
    },
    {
      text: '滚动到顶部 / 底部。',
      run: async (env) => {
        const page = env.page;
        const scroller = page.locator('.chat-scroll-fade');
        const box = await scroller.boundingBox();
        if (box) {
          // 像用户一样先翻到顶再回到底：顶部能翻到第 1 轮，底部能停住不弹回
          await page.mouse.wheel(0, -(box.height * 40));
          await sleep(800);
          await page.mouse.wheel(0, box.height * 40);
          await sleep(1_500);
        }
        // 停在底部：最后一轮在视口里、「回到底部」浮钮不出现
        const lastTurn = page.locator('[data-trace-turn-id]').last();
        const [lastBox, scrollBox] = await Promise.all([
          lastTurn.boundingBox().catch(() => null),
          scroller.boundingBox().catch(() => null),
        ]);
        if (!lastBox || !scrollBox) throw new Error('找不到转写区滚动容器（无法判断滚动位置）');
        const inView = lastBox.y + lastBox.height > scrollBox.y && lastBox.y < scrollBox.y + scrollBox.height;
        const jumpVisible = await page.getByRole('button', { name: /回到底部|Jump to bottom/ }).isVisible().catch(() => false);
        if (!inView || jumpVisible) throw new Error(`打开后没有停在底部（最后一轮在视口=${inView}，「回到底部」浮钮=${jumpVisible}）——可能只显示最后几条或滚动位置丢了`);
      },
    },
    {
      text: '核对可观测量：messages 表该会话条数与界面轮数一致；session-load-error 不出现。',
      run: async (env) => {
        const page = env.page;
        // 转写区是虚拟滚动，DOM 里只有可见的几轮；总轮数以右侧「轮次导航」展开后的「全部 N 轮」为准
        const expand = page.getByRole('button', { name: /展开清单|Expand list/ }).first();
        if (await expand.isVisible().catch(() => false)) await expand.click();
        const rail = page.getByTestId('turn-rail-list');
        await rail.waitFor({ state: 'visible', timeout: 15_000 });
        const headText = await rail.innerText();
        const railTurns = Number(/(?:全部|All)\s*(\d+)\s*(?:轮|turns)/.exec(headText)?.[1] ?? 0);
        if (railTurns !== TURNS) throw new Error(`界面显示 ${railTurns} 轮，会话里种下去的是 ${TURNS} 轮（${headText.split('\n')[0]}）`);
        if (await page.getByTestId('session-load-error').isVisible().catch(() => false)) throw new Error('翻滚后出现了 session-load-error');
        await expectDb(env, (d) => {
          if (!env.sessionIds.length) return '没有记录到被打开的会话 id';
          const rows = inSessions(d.messages, env.sessionIds);
          const users = rows.filter((m) => m.role === 'user').length;
          const assistants = rows.filter((m) => m.role === 'assistant').length;
          if (users !== TURNS) return `messages 表里该会话有 ${users} 条用户消息，应为 ${TURNS}（每轮一条）`;
          if (assistants !== TURNS) return `messages 表里该会话有 ${assistants} 条助手消息，应为 ${TURNS}（每轮一条）`;
          return null;
        });
      },
    },
  ],
};

import { getSettings, putSettings } from './api';
import type { AttemptEnv, FlowDef } from './types';
import type { Page } from 'playwright';
import { sleep } from './ui';

// 界面语言中英切换。web 构建（webServer 注入 __CODE_AGENT_TOKEN__ → isWebMode()=true）把设置页
// 「界面语言」的选项按钮禁用了（AppearanceSettings.tsx disabled={isWebMode()}）：真用户在网页版
// 点不了它。按施工环境规则取最接近真实的路：设置页照开、核对「界面语言」区域在场，切换动作用
// 按钮背后同一个 host 入口 PUT /api/settings 完成，页面重载后按真用户视角断言中英文界面。
const ZH_SIDEBAR = '新任务';
const EN_SIDEBAR = 'New task';
const EN_WELCOME = 'Which planet are we heading to?';
const SWITCH_TIMEOUT_MS = 30_000;

const hasCjk = (text: string): boolean => /[\u4e00-\u9fff]/.test(text);

async function restoreZh(server: { port: number; token: string }): Promise<void> {
  await putSettings(server, { ui: { language: 'zh' } });
}

/** 打开设置弹窗并点进「外观」页，等「界面语言」区块出现（地图 F17 点名的设置项）。 */
async function openAppearanceLanguage(page: Page): Promise<void> {
  await page.keyboard.press('ControlOrMeta+Comma');
  const dialog = page.getByRole('dialog', { name: '设置' });
  await dialog.waitFor({ state: 'visible', timeout: 15_000 });
  await dialog.getByRole('button', { name: '外观', exact: true }).first().click();
  await dialog.getByRole('heading', { name: '界面语言' }).waitFor({ state: 'visible', timeout: 15_000 });
}

/** 切换语言：按钮可用就点（真用户的路）；web 构建禁用按钮时用按钮背后同一入口 PUT /api/settings。 */
async function switchLanguage(env: AttemptEnv, lang: 'en' | 'zh'): Promise<void> {
  const page = env.page;
  await openAppearanceLanguage(page);
  const option = page.getByRole('dialog', { name: '设置' }).getByRole('button', { name: lang === 'en' ? 'English' : '简体中文' }).first();
  await option.waitFor({ state: 'visible', timeout: 10_000 });
  if (await option.isEnabled()) {
    await option.click();
  } else {
    if (lang === 'en') env.note('web 构建把「界面语言」选项禁用了（AppearanceSettings isWebMode），改用按钮背后同一入口 PUT /api/settings 切换（偏差，见证据档）');
    await putSettings(env.server, { ui: { language: lang } });
    // 设置变化没有事件推送：像用户重开页面一样 reload，App 启动时会读回语言
    await page.reload();
    await page.getByTestId('sidebar-new-task').waitFor({ timeout: SWITCH_TIMEOUT_MS });
    return;
  }
  // 按钮路径即时生效：关掉设置弹窗，等主界面文字换过来
  await page.keyboard.press('Escape');
  const want = lang === 'en' ? EN_SIDEBAR : ZH_SIDEBAR;
  const deadline = Date.now() + SWITCH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if ((await page.getByTestId('sidebar-new-task').innerText().catch(() => '')) === want) return;
    await sleep(300);
  }
  throw new Error(`点「${lang === 'en' ? 'English' : '简体中文'}」后 ${SWITCH_TIMEOUT_MS / 1000}s 界面还是没切过去`);
}

async function assertLanguage(env: AttemptEnv, lang: 'en' | 'zh'): Promise<void> {
  const page = env.page;
  const settings = await getSettings(env.server);
  if (settings.ui?.language !== lang) throw new Error(`GET /api/settings 的 ui.language 是「${settings.ui?.language}」，应为「${lang}」`);
  const sidebar = await page.getByTestId('sidebar-new-task').innerText();
  if (sidebar !== (lang === 'en' ? EN_SIDEBAR : ZH_SIDEBAR)) throw new Error(`侧栏「新任务」按钮文案是「${sidebar}」（语言 ${lang}）`);
  if (lang === 'en') {
    // 英文下侧栏区域不允许残留中文；欢迎标题应是英文句
    const welcome = await page.getByTestId('chat-welcome-title').innerText().catch(() => '');
    if (welcome !== EN_WELCOME) throw new Error(`英文下欢迎标题是「${welcome}」，应为「${EN_WELCOME}」`);
    const sidebarText = (await page.getByTestId('sidebar-capability-zone').innerText().catch(() => ''))
      + '\n' + (await page.getByTestId('sidebar-session-scroll').innerText().catch(() => ''));
    if (hasCjk(sidebarText)) {
      const residue = sidebarText.split('\n').filter((line) => hasCjk(line)).slice(0, 5).join(' / ');
      throw new Error(`英文下侧栏残留中文：${residue}`);
    }
  }
}

export const f17: FlowDef = {
  id: 'F17',
  title: '界面语言中英切换',
  // 语言是全页面基线：任何一步失败也要恢复 zh，否则后面每条流程的中文选择器全断
  prepare: async (server) => { await restoreZh(server); },
  cleanup: async (server) => { await restoreZh(server); },
  steps: [
    {
      text: '设置里找到「界面语言」，选 English。',
      run: async (env) => {
        await assertLanguage(env, 'zh');
        env.scratch.zhBefore = (await getSettings(env.server)).ui?.language;
        await switchLanguage(env, 'en');
      },
    },
    {
      text: '看主界面和输入框占位。',
      run: async (env) => {
        await assertLanguage(env, 'en');
        // 输入框占位也应是英文（空会话时 composer 的 placeholder）
        const placeholder = await env.page.getByTestId('chat-composer-textarea').getAttribute('placeholder').catch(() => '');
        if (placeholder && hasCjk(placeholder)) throw new Error(`英文下输入框占位还是中文：「${placeholder}」`);
        if (placeholder) env.note(`英文下输入框占位：${placeholder}`);
      },
    },
    {
      text: '切回简体中文。',
      run: async (env) => {
        await switchLanguage(env, 'zh');
        await assertLanguage(env, 'zh');
      },
    },
  ],
};

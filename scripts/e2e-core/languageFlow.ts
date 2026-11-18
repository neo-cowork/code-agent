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

/** 打开设置弹窗并点进「外观」页，等「界面语言」区块出现（地图 F17 点名的设置项）。
 *  步骤 3 时界面已是英文：设置页各名字都要中英两态兼容。 */
async function openAppearanceLanguage(page: Page): Promise<void> {
  await page.keyboard.press('ControlOrMeta+Comma');
  const dialog = page.getByRole('dialog', { name: /^(设置|Settings)$/ });
  await dialog.waitFor({ state: 'visible', timeout: 15_000 });
  await dialog.getByRole('button', { name: /^(外观|Appearance)$/ }).first().click();
  await dialog.getByRole('heading', { name: /^(界面语言|Interface language)$/ }).waitFor({ state: 'visible', timeout: 15_000 });
}

/** 切换语言：按钮可用就点（真用户的路）；web 构建禁用按钮时用按钮背后同一入口 PUT /api/settings。 */
async function switchLanguage(env: AttemptEnv, lang: 'en' | 'zh'): Promise<void> {
  const page = env.page;
  await openAppearanceLanguage(page);
  const option = page.getByRole('dialog', { name: /^(设置|Settings)$/ }).getByRole('button', { name: lang === 'en' ? 'English' : '简体中文' }).first();
  await option.waitFor({ state: 'visible', timeout: 10_000 });
  if (await option.isEnabled()) {
    await option.click();
  } else {
    if (lang === 'en') env.note('web 构建把「界面语言」选项禁用了（AppearanceSettings isWebMode），改用按钮背后同一入口 PUT /api/settings 切换（偏差，见证据档）');
    await putSettings(env.server, { ui: { language: lang } });
    // 设置变化没有事件推送：像用户「返回应用」一样回主界面，App 启动时会读回语言
    //（设置页是路由且会话里记着它：回首页后若还停在设置页，点「返回应用」退出）
    await page.goto(`http://127.0.0.1:${env.server.port}/`);
    await page.getByTestId('sidebar-new-task').waitFor({ timeout: SWITCH_TIMEOUT_MS });
    await page.getByRole('button', { name: /Back to app|返回应用/ }).click({ timeout: 5_000 }).catch(() => {});
    await sleep(500);
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
    // 欢迎标题要在「新任务」空会话态看（页面可能停在上一条会话上，先点新任务），并等它真渲染出来
    await page.getByTestId('sidebar-new-task').click();
    const welcome = page.getByTestId('chat-welcome-title');
    await welcome.waitFor({ state: 'visible', timeout: 20_000 });
    const text = (await welcome.innerText()).trim();
    if (text !== EN_WELCOME) throw new Error(`英文下欢迎标题是「${text}」，应为「${EN_WELCOME}」`);
    // 残留中文只查侧栏的固定 UI 区（能力区：能力中心/协作空间/资料库/自动化）；会话标题是用户自己起的
    // 中文内容，不算界面残留
    const sidebarText = await page.getByTestId('sidebar-capability-zone').innerText().catch(() => '');
    if (hasCjk(sidebarText)) {
      const residue = sidebarText.split('\n').filter((line) => hasCjk(line)).slice(0, 5).join(' / ');
      throw new Error(`英文下侧栏固定区残留中文：${residue}`);
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

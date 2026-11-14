import { test, expect } from './fixtures/axeTest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dismissFirstRunDialogs } from './firstRunDialogs';

const SECRET = 'sk-FIXTURE-SECRET-123';
const SERVER_NAME = 'external-import-nonce';
const screenshotDir = process.env.EXTERNAL_MCP_SCREENSHOT_DIR
  || path.join('test-results', 'external-import-mcp');
const homeDir = process.env.CODE_AGENT_E2E_HOME
  || path.join(os.tmpdir(), `code-agent-e2e-home-${process.env.E2E_WEB_PORT}`);
const dataDir = process.env.CODE_AGENT_E2E_DATA_DIR
  || path.join(os.tmpdir(), `code-agent-e2e-data-${process.env.E2E_WEB_PORT}`);
const nonceServerPath = path.resolve('tests/fixtures/mcp/external-import-nonce-server.mjs');
const fullCommand = `${process.execPath} ${nonceServerPath}`;

test.setTimeout(120_000);

test('MCP import is disabled by default and enables one server after full-command confirmation', async ({ page }) => {
  mkdirSync(screenshotDir, { recursive: true });
  mkdirSync(path.join(homeDir, '.cursor'), { recursive: true });
  writeFileSync(path.join(homeDir, '.cursor', 'mcp.json'), JSON.stringify({
    mcpServers: {
      [SERVER_NAME]: {
        command: process.execPath,
        args: [nonceServerPath],
      },
      'secret-fixture': {
        command: 'npx',
        args: ['-y', 'secret-mcp'],
        env: { GITHUB_TOKEN: SECRET },
      },
    },
  }, null, 2));

  await page.goto('/');
  await expect(page.locator('.h-screen')).toBeVisible({ timeout: 15_000 });
  await dismissFirstRunDialogs(page);
  await page.keyboard.press('ControlOrMeta+Comma');
  const settings = page.getByRole('dialog', { name: '设置' });
  await expect(settings).toBeVisible({ timeout: 10_000 });
  const nav = settings.locator('aside nav');
  await nav.getByRole('button', { name: '从其他 AI 应用导入', exact: true }).click();

  const cursorSource = page.getByTestId('external-import-source-cursor');
  await expect(cursorSource).toContainText('MCP 服务器 2');
  await expect(page.getByTestId('external-import-mcp-note')).toContainText('默认停用');
  await page.screenshot({ path: path.join(screenshotDir, '01-select.png'), fullPage: false });

  await page.getByRole('button', { name: '预览要导入的内容', exact: true }).click();
  const preview = page.getByTestId('external-import-preview-mcp');
  await expect(preview).toBeVisible();
  await expect(page.getByTestId(`external-import-mcp-item-cursor-${SERVER_NAME}`)).toContainText(fullCommand);
  await expect(page.getByTestId('external-import-mcp-item-cursor-secret-fixture')).toContainText('需要先补 GITHUB_TOKEN 才能用');
  await expect(preview).not.toContainText(SECRET);
  await page.screenshot({ path: path.join(screenshotDir, '02-preview.png'), fullPage: false });

  await page.getByRole('button', { name: '开始导入', exact: true }).click();
  const results = page.getByTestId('external-import-results-mcp');
  await expect(results).toBeVisible();
  await expect(results).toContainText('MCP 服务器：导入 2 个，跳过 0 个');
  const nonceRow = page.getByTestId(`external-import-mcp-item-cursor-${SERVER_NAME}`);
  const secretRow = page.getByTestId('external-import-mcp-item-cursor-secret-fixture');
  await expect(nonceRow).toContainText('已导入（未启用）');
  await expect(secretRow).toContainText('已导入（未启用）');
  await expect(secretRow).toContainText('需要先补 GITHUB_TOKEN 才能用');
  await expect(results).not.toContainText(SECRET);

  const configPath = path.join(dataDir, 'mcp.json');
  const imported = JSON.parse(readFileSync(configPath, 'utf8')) as {
    servers: Array<{ name: string; enabled: boolean }>;
  };
  expect(imported.servers.map((server) => [server.name, server.enabled])).toEqual([
    [SERVER_NAME, false],
    ['secret-fixture', false],
  ]);
  expect(readFileSync(configPath, 'utf8')).not.toContain(SECRET);
  await page.screenshot({ path: path.join(screenshotDir, '03-imported-off.png'), fullPage: false });

  await nonceRow.getByRole('switch', { name: '启用这个 MCP 服务器' }).click();
  const confirmation = page.getByTestId('external-import-mcp-enable-content');
  await expect(confirmation).toContainText('启用后 Neo 会在你的电脑上运行：');
  await expect(confirmation).toContainText(fullCommand);
  await page.screenshot({ path: path.join(screenshotDir, '04-enable-confirm.png'), fullPage: false });
  await page.getByRole('button', { name: '确认启用', exact: true }).click();
  await expect(nonceRow).toContainText('已启用', { timeout: 30_000 });
  await expect(secretRow).toContainText('已导入（未启用）');

  const enabled = JSON.parse(readFileSync(configPath, 'utf8')) as {
    servers: Array<{ name: string; enabled: boolean }>;
  };
  expect(enabled.servers.find((server) => server.name === SERVER_NAME)?.enabled).toBe(true);
  expect(enabled.servers.find((server) => server.name === 'secret-fixture')?.enabled).toBe(false);
  await page.screenshot({ path: path.join(screenshotDir, '05-enabled-one.png'), fullPage: false });
});

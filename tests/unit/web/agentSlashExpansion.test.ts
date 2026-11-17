import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDefaultWorkDirectory, getLegacyDefaultWorkDirectory } from '../../../src/host/config/configPaths';
import { getPromptCommandService } from '../../../src/host/services/commands/promptCommandService';
import { containsCjk } from '../../../src/renderer/utils/containsCjk';
import { CHOOSE_FOLDER_ENTRY_LABEL } from '../../../src/shared/i18n/chooseFolderEntry';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';
import { expandSlashPromptForModel } from '../../../src/web/routes/agentSlashExpansion';

const hostUi = vi.hoisted(() => ({ locale: 'zh' as 'zh' | 'en' }));

vi.mock('../../../src/host/config/hostUiLocale', () => ({
  getHostUiLocale: () => hostUi.locale,
}));

vi.mock('../../../src/host/mcp/mcpClient', () => ({
  getMCPClient: () => ({ getPrompts: () => [] }),
}));

vi.mock('../../../src/host/security/folderTrustService', () => ({
  isProjectConfigTrusted: async () => false,
}));

const noFolderInstruction = (locale: 'zh' | 'en') => `Call no tools. Reply with exactly the following text, character for character, and nothing else:\n${locale === 'en'
  ? `No folder has been chosen yet; click "${CHOOSE_FOLDER_ENTRY_LABEL.en}" in the sidebar, then send /init-memory again.`
  : `尚未选择文件夹，请在侧栏点击“${CHOOSE_FOLDER_ENTRY_LABEL.zh}”，然后再次发送 /init-memory。`}`;

describe('expandSlashPromptForModel /init-memory working directory guard', () => {
  let tempRoot: string;
  let dataDir: string;
  let originalHome: string | undefined;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    hostUi.locale = 'zh';
    originalHome = process.env.CODE_AGENT_HOME;
    originalDataDir = process.env.CODE_AGENT_DATA_DIR;
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'slash-init-memory-'));
    const home = path.join(tempRoot, 'home');
    dataDir = path.join(home, '.code-agent');
    await fs.mkdir(dataDir, { recursive: true });
    process.env.CODE_AGENT_HOME = home;
    process.env.CODE_AGENT_DATA_DIR = dataDir;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.CODE_AGENT_HOME;
    else process.env.CODE_AGENT_HOME = originalHome;
    if (originalDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = originalDataDir;
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it.each([
    ['planned session folder', () => path.join(getDefaultWorkDirectory(), '任务_1109_init-memory')],
    ['default work root', () => getDefaultWorkDirectory()],
    ['legacy default work directory', () => getLegacyDefaultWorkDirectory(dataDir)],
  ])('returns a locale-locked no-folder instruction for a %s', async (_name, workingDirectory) => {
    for (const locale of ['zh', 'en'] as const) {
      hostUi.locale = locale;
      const result = await expandSlashPromptForModel('/init-memory', workingDirectory());

      expect(result).toBe(noFolderInstruction(locale));
      expect(result).toContain(CHOOSE_FOLDER_ENTRY_LABEL[locale]);
      expect(result).not.toContain('ProposeProjectMemory');
      expect(result).not.toContain('ListDirectory');
      expect(result).not.toContain(workingDirectory());
      expect(result).not.toMatch(/(?:^|\s)(?:\/(?:Users|home|tmp|var|private)\/|[A-Za-z]:[\\/])/);
      if (locale === 'zh') expect(result).not.toContain(CHOOSE_FOLDER_ENTRY_LABEL.en);
      else expect(containsCjk(result)).toBe(false);
    }
  });

  it.each(['zh', 'en'] as const)('uses the exact %s sidebar row label in the no-folder hint', async (locale) => {
    hostUi.locale = locale;
    const result = await expandSlashPromptForModel('/init-memory', getDefaultWorkDirectory());
    const sidebarLabel = locale === 'zh'
      ? zh.sidebarProject.chooseFolderEntry
      : en.sidebarProject.chooseFolderEntry;

    expect(sidebarLabel).toBe(CHOOSE_FOLDER_ENTRY_LABEL[locale]);
    expect(result).toContain(sidebarLabel);
  });

  it('keeps the resolved expansion byte for byte for a user-selected folder', async () => {
    const selectedDirectory = path.join(tempRoot, 'selected-project');
    await fs.mkdir(selectedDirectory);
    const resolution = await getPromptCommandService().resolveInvocation('/init-memory', selectedDirectory);

    expect(resolution).not.toBeNull();
    expect(await expandSlashPromptForModel('/init-memory', selectedDirectory)).toBe(resolution!.prompt);
  });
});

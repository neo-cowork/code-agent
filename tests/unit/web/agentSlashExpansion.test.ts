import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDefaultWorkDirectory, getLegacyDefaultWorkDirectory } from '../../../src/host/config/configPaths';
import { getPromptCommandService } from '../../../src/host/services/commands/promptCommandService';
import { CHOOSE_FOLDER_ENTRY_LABEL } from '../../../src/shared/i18n/chooseFolderEntry';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';
import { expandSlashPromptForModel } from '../../../src/web/routes/agentSlashExpansion';

vi.mock('../../../src/host/mcp/mcpClient', () => ({
  getMCPClient: () => ({ getPrompts: () => [] }),
}));

vi.mock('../../../src/host/security/folderTrustService', () => ({
  isProjectConfigTrusted: async () => false,
}));

const NO_FOLDER_INSTRUCTION = `Call no tools. Reply with exactly one plain sentence in the user's language saying that no folder has been chosen yet and directing them to click "${CHOOSE_FOLDER_ENTRY_LABEL.en}" (Chinese label: "${CHOOSE_FOLDER_ENTRY_LABEL.zh}") in the sidebar, then asking them to send /init-memory again.`;

describe('expandSlashPromptForModel /init-memory working directory guard', () => {
  let tempRoot: string;
  let dataDir: string;
  let originalHome: string | undefined;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
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
  ])('returns the no-folder instruction for a %s', async (_name, workingDirectory) => {
    const result = await expandSlashPromptForModel('/init-memory', workingDirectory());

    expect(result).toBe(NO_FOLDER_INSTRUCTION);
    // 提示词点名的入口必须与侧栏实际渲染的文案字面一致
    expect(result).toContain(`"${zh.sidebarProject.chooseFolderEntry}"`);
    expect(result).toContain(`"${en.sidebarProject.chooseFolderEntry}"`);
    expect(result).not.toContain('ProposeProjectMemory');
    expect(result).not.toContain('ListDirectory');
  });

  it('keeps the resolved expansion byte for byte for a user-selected folder', async () => {
    const selectedDirectory = path.join(tempRoot, 'selected-project');
    await fs.mkdir(selectedDirectory);
    const resolution = await getPromptCommandService().resolveInvocation('/init-memory', selectedDirectory);

    expect(resolution).not.toBeNull();
    expect(await expandSlashPromptForModel('/init-memory', selectedDirectory)).toBe(resolution!.prompt);
  });
});

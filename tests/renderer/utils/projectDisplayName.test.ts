import { describe, expect, it } from 'vitest';
import { UNSORTED_PROJECT_ID, UNSORTED_PROJECT_NAME } from '../../../src/shared/contract/project';
import { languages } from '../../../src/renderer/i18n';
import { getProjectDisplayName } from '../../../src/renderer/utils/projectDisplayName';

describe('项目显示名（FB-1296）', () => {
  const unsorted = { id: UNSORTED_PROJECT_ID, name: UNSORTED_PROJECT_NAME };

  it('保留项目按界面语言显示；中文与库里的固定名逐字相同', () => {
    expect(getProjectDisplayName(unsorted, languages.zh)).toBe(UNSORTED_PROJECT_NAME);
    // 英文措辞取 main 的语言包键（mentionPanel.unsortedProjectName）
    expect(getProjectDisplayName(unsorted, languages.en)).toBe(languages.en.mentionPanel.unsortedProjectName);
    expect(getProjectDisplayName(unsorted, languages.en)).toBe('Unsorted');
  });

  it('认的是保留 id，不是名字：用户自己起名叫「未分类」的项目原样显示', () => {
    const userProject = { id: 'proj_user_1', name: '未分类' };
    expect(getProjectDisplayName(userProject, languages.en)).toBe('未分类');
    expect(getProjectDisplayName({ id: 'proj_user_2', name: 'Roadmap' }, languages.zh)).toBe('Roadmap');
  });
});

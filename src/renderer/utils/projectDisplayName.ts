import { UNSORTED_PROJECT_ID } from '@shared/contract/project';
import type { Translations } from '../i18n';

/**
 * 项目显示名：未分类桶（proj_unsorted）的 host 存名是 zh 常量「未分类」，
 * 直出会把中文漏进英文界面。按 id 换成 i18n 文案（zh 未分类 / en Unsorted），
 * 键在 id 上，桶的存名被改也照样命中。
 */
export function getProjectDisplayName(project: { id: string; name: string }, t: Translations): string {
  return project.id === UNSORTED_PROJECT_ID ? t.mentionPanel.unsortedProjectName : project.name;
}

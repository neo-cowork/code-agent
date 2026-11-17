import { UNSORTED_PROJECT_ID } from '@shared/contract/project';
import type { Translations } from '../i18n/zh';

/**
 * 项目显示名的唯一出口。保留项目 `proj_unsorted` 在库里的名字是固定的中文，
 * 界面上一律按语言包显示；其余项目显示用户自己起的名字。
 */
export function getProjectDisplayName(
  project: { id: string; name: string },
  copy: Pick<Translations['sidebarProject'], 'unsortedProjectName'>,
): string {
  return project.id === UNSORTED_PROJECT_ID ? copy.unsortedProjectName : project.name;
}

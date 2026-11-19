import type { Translations } from '../i18n';

type ProjectArtifactKindLabels = Translations['sidebarProject']['artifactKind'];

/**
 * 项目资产类型的用户可见名。
 * process-output / process-log 的词条键是驼峰；词条表没有的 kind 回落到 file
 * （文件 / File），不许把内部标识原样显示出来。
 */
export function projectArtifactKindLabel(
  kind: string,
  labels: ProjectArtifactKindLabels,
): string {
  const key = kind === 'process-output'
    ? 'processOutput'
    : kind === 'process-log'
      ? 'processLog'
      : kind;
  const label = (labels as Record<string, string | undefined>)[key];
  return label ? label : labels.file;
}

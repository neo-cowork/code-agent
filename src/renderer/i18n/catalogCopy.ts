// 「按 id 查显示文案」的几份语言包在这里并成一份，再并入 zh/en 总表。
// 两个总表文件已贴行数上限，新增这类语言包往这里加，不要再去总表里加 import。
import { capabilityDetailCopyEn, capabilityDetailCopyZh } from './capabilityDetailCopy';
import { engineManifestEn, engineManifestZh } from './engineManifest';
import { engineModelPanelEn, engineModelPanelZh } from './engineModelPanel';
import { visualModelLabelsEn, visualModelLabelsZh } from './visualModelLabels';

export const catalogCopyZh = {
  ...engineModelPanelZh,
  ...engineManifestZh,
  ...visualModelLabelsZh,
  ...capabilityDetailCopyZh,
};

export const catalogCopyEn: typeof catalogCopyZh = {
  ...engineModelPanelEn,
  ...engineManifestEn,
  ...visualModelLabelsEn,
  ...capabilityDetailCopyEn,
};

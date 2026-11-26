// 旧会话展示层兜底（不迁移数据）：
// ① 确定性组队旧行以「【组队 · 配方名】」开头 → 展示时剥掉前缀，只留用户原话；
// ② 主理人路径旧行是整段编排 brief（含「执行铁律…spawn_agent」+「agents JSON：」）→ 展示为空（不渲染）。
// 新行只落用户原话，brief 走 meta 通道，故这里只服务历史数据。
const LEGACY_PREFIX = /^【组队 · [^】]*】/;
const SEED_MARKERS = ['执行铁律：第一步必须调用 spawn_agent', 'agents JSON：'];

export function stripLegacyTeamRecipeSeed(content: string): string {
  if (SEED_MARKERS.every((marker) => content.includes(marker))) return '';
  return content.replace(LEGACY_PREFIX, '');
}

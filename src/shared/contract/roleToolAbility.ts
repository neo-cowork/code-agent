import { findConnectorToolMetadata } from './workbenchTools';

/**
 * 角色工具 → 用户看得懂的中文能力名。
 * 连接器类（日历/邮件/提醒事项…）沿用 workbenchTools 的连接器名；核心工具的名字与角色确认卡
 * （renderer receiptPresentation.roleCapabilityLabels）保持同一说法。
 */
const CORE_TOOL_ABILITY_ZH: Readonly<Record<string, string>> = {
  read: '读取和查找文件',
  readfile: '读取和查找文件',
  glob: '读取和查找文件',
  grep: '读取和查找文件',
  listdirectory: '读取和查找文件',
  write: '写入和编辑文件',
  writefile: '写入和编辑文件',
  edit: '写入和编辑文件',
  editfile: '写入和编辑文件',
  multiedit: '写入和编辑文件',
  bash: '运行命令',
  websearch: '联网搜索',
  webfetch: '打开网页',
  memoryread: '记住和回想',
  memorywrite: '记住和回想',
  history: '记住和回想',
};

export const UNKNOWN_TOOL_ABILITY_ZH = '其他能力';

export function roleToolAbilityLabel(toolName: string): string {
  const name = toolName.trim();
  const connector = findConnectorToolMetadata(name);
  if (connector) return connector.connectorName;
  return CORE_TOOL_ABILITY_ZH[name.toLowerCase().replace(/[-_\s]/g, '')] ?? UNKNOWN_TOOL_ABILITY_ZH;
}

/** 按能力名归并，保留原始工具 id 供模型对照：[{ label: '日历', toolNames: ['calendar', …] }] */
export function groupRoleToolsByAbility(toolNames: readonly string[]): Array<{ label: string; toolNames: string[] }> {
  const groups = new Map<string, string[]>();
  for (const raw of toolNames) {
    const name = raw.trim();
    if (!name) continue;
    const label = roleToolAbilityLabel(name);
    groups.set(label, [...(groups.get(label) ?? []), name]);
  }
  return [...groups].map(([label, names]) => ({ label, toolNames: names }));
}

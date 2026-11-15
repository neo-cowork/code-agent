// ============================================================================
// 设置 → Workspace 的「配置范围」摘要：英文界面下的文案（FB-1290）。
//
// 摘要在 workspaceConfigScope.ts 里用中文拼出来（大量模块级表格 + 运行时探测结果）。
// 这里在 IPC 出口做一次整体替换：界面语言是英文时，把摘要里每一条已知的中文句子
// 换成英文，路径、文件名等其它字符串原样不动。中文界面不经过这里，输出逐字不变。
//
// 新增或改动中文句子时必须在这里补英文，否则英文界面会原样露出中文——
// tests/unit/ipc/workspaceConfigScopeEn.test.ts 会逐条核对源码里的中文句子是否都有对应。
// ============================================================================

const EXACT: Record<string, string> = {
  // 写到哪一层的建议
  '身份、记忆、个人偏好': 'Identity, memory and personal preferences',
  '长期称呼、个人习惯、私人记忆和跨项目默认行为。': 'How you like to be addressed, personal habits, private memory and defaults that apply across projects.',
  '写到 User 层；不要放进项目模板或团队仓库。': 'Write to the User layer; keep it out of project templates and team repositories.',
  '项目画像、规则、团队约定': 'Project profile, rules and team conventions',
  '项目事实、技术栈、测试命令、路径规则和协作约束。': 'Project facts, tech stack, test commands, path rules and collaboration constraints.',
  '写到 Project 层；提交前确认没有个人路径、账号和 token。': 'Write to the Project layer; before committing, make sure it has no personal paths, accounts or tokens.',
  'MCP 共享模板': 'Shared MCP templates',
  '团队都需要的 MCP server 名称、命令、基础参数和禁用态草稿。': 'MCP server names, commands, base arguments and disabled drafts the whole team needs.',
  '模板可以进 Project 层；密钥、私有端点和机器端口放到 Local/User。': 'Templates can go in the Project layer; keys, private endpoints and machine ports belong in Local/User.',
  'MCP token、端口、私有 endpoint': 'MCP tokens, ports and private endpoints',
  '个人凭证、本机路径、localhost、内网地址和私有服务参数。': 'Personal credentials, local paths, localhost, internal addresses and private service settings.',
  '写到 Local 覆盖文件或 User 层；保持在 gitignore 内。': 'Write to the Local override file or the User layer; keep it in gitignore.',
  'hooks 与自动化命令': 'Hooks and automation commands',
  'lint、typecheck、格式化、审计和本机辅助脚本。': 'Lint, typecheck, formatting, audit and local helper scripts.',
  '团队验证动作放 Project hooks；个人自动化放 User hooks，本机路径放 Local。': 'Team checks go in Project hooks; personal automation goes in User hooks; local paths go in Local.',
  'skills、agents、工作流模板': 'Skills, agents and workflow templates',
  '可复用技能、agent 定义、团队工作流和能力模板。': 'Reusable skills, agent definitions, team workflows and capability templates.',
  '团队共用模板放 Project；私人方法、账号和本机路径留在 User/Local。': 'Shared templates go in Project; private methods, accounts and local paths stay in User/Local.',
  'UI 偏好和最近目录': 'UI preferences and recent folders',
  '窗口偏好、最近工作区、浏览器 profile、cache 和本地数据库。': 'Window preferences, recent workspaces, browser profile, cache and the local database.',
  '让 Settings UI 写 Runtime；不要复制到项目配置。': 'Let Settings write these to Runtime; do not copy them into project configuration.',
  // 共享前的安全提示
  '本机绝对路径': 'Absolute local paths',
  '共享前改成相对路径、环境变量，或移到 Local/User 层。': 'Before sharing, switch to relative paths or environment variables, or move it to the Local/User layer.',
  '疑似 secret': 'Possible secrets',
  '不要共享原值；改用环境变量、secretRef，或放入本机私有配置。': 'Do not share the raw value; use an environment variable or secretRef, or keep it in private local configuration.',
  'localhost / 内网 endpoint': 'localhost / internal endpoints',
  '团队共享模板里保留占位符；真实地址放 Local 覆盖。': 'Keep placeholders in shared templates; put the real address in the Local override.',
  '危险 shell 模式': 'Risky shell patterns',
  '共享前改成受限脚本、显式确认动作，或只保留在个人 hooks。': 'Before sharing, turn it into a restricted script or an explicitly confirmed action, or keep it in personal hooks only.',
  'hooks 写在 settings.json': 'Hooks are defined in settings.json',
  'settings.json 内含 hooks 字段，但当前 hook parser 读取 hooks/hooks.json。': 'settings.json contains a hooks field, but hooks are read from hooks/hooks.json.',
  '把项目 hooks 移到 .code-agent/hooks/hooks.json，settings.json 只保留非 hooks 设置。': 'Move project hooks to .code-agent/hooks/hooks.json and keep only non-hook settings in settings.json.',
  'hooks.json 位置不符合当前约定': 'hooks.json is not in the expected location',
  '发现 .code-agent/hooks.json；当前项目 hooks 约定位置是 .code-agent/hooks/hooks.json。': 'Found .code-agent/hooks.json; project hooks are expected at .code-agent/hooks/hooks.json.',
  '把文件移到 .code-agent/hooks/hooks.json，避免团队以为它已经生效。': 'Move the file to .code-agent/hooks/hooks.json so the team does not assume it is already in effect.',
  // User 层
  '跨项目人格、称呼、沟通方式和长期偏好。': 'Persona, form of address, communication style and long-term preferences across projects.',
  '全局 hooks': 'Global hooks',
  '所有工作区都会继承的个人自动化。': 'Personal automation inherited by every workspace.',
  '用户 MCP': 'User MCP',
  '跨项目可用的个人 MCP server。': 'Personal MCP servers available across projects.',
  '个人 skills': 'Personal skills',
  '当前用户安装的技能库。': 'Skills installed for the current user.',
  '个人 agents': 'Personal agents',
  '当前用户的自定义 agent 定义。': 'Custom agent definitions for the current user.',
  '用户记忆、画像、纠偏和近期会话索引。': 'User memory, profile, corrections and the recent conversation index.',
  // Project 层
  '这里的 hooks 不会被当前 hook parser 读取；请使用 .code-agent/hooks/hooks.json。': 'Hooks defined here are not read; use .code-agent/hooks/hooks.json instead.',
  '项目定位、技术约束、测试命令和团队协作约定。': 'Project positioning, technical constraints, test commands and team conventions.',
  '项目 hooks': 'Project hooks',
  '项目统一的 lint、typecheck、验证和审计动作。': 'Project-wide lint, typecheck, verification and audit actions.',
  '项目 settings': 'Project settings',
  '项目级文件化设置；hooks 应放到 hooks/hooks.json。': 'File-based project settings; hooks belong in hooks/hooks.json.',
  '项目 MCP': 'Project MCP',
  '团队共享的 MCP server 模板。': 'MCP server templates shared by the team.',
  '项目 skills': 'Project skills',
  '随项目走的技能模板。': 'Skill templates that travel with the project.',
  '项目 agents': 'Project agents',
  '随项目走的自定义 agent 定义。': 'Custom agent definitions that travel with the project.',
  '工作区 instruction discovery 文件。': 'Workspace instruction file.',
  'Claude 兼容 instruction discovery 文件。': 'Claude-compatible instruction file.',
  // Local 层
  '同一项目里个人机器上的 token、端口和私有 endpoint。': 'Tokens, ports and private endpoints for your own machine within this project.',
  'Claude 兼容本地设置；Agent Neo 只继承部分 legacy 链路。': 'Claude-compatible local settings; Agent Neo only inherits part of them.',
  '兼容线索，不是通用 local 层': 'Kept for compatibility; not a general local layer',
  // Runtime 层
  '应用 settings': 'App settings',
  'Settings UI 正在读写的主配置文件。': 'The main configuration file that Settings reads and writes.',
  '应用数据库': 'App database',
  '会话、消息、记忆和工具记录的本地数据库。': 'Local database of conversations, messages, memory and tool records.',
  '浏览器 profile': 'Browser profile',
  'Managed browser 登录态、cookies、历史和缓存。': 'Sign-in state, cookies, history and cache of the managed browser.',
  '内置默认': 'Built-in defaults',
  '无文件命中时使用的产品默认 prompt、hooks 事件和能力定义。': 'Default prompts, hook events and capability definitions used when no file applies.',
  // 四层的总说明
  '跨项目、当前 OS 用户私有的配置和能力。': 'Configuration and capabilities private to the current OS user, across projects.',
  '跟随当前工作区，可审计后进入仓库的团队配置。': 'Team configuration that follows the current workspace and can be committed after review.',
  '未设置工作区': 'No workspace set',
  '当前项目里的个人覆盖和私有端点，应该留在 gitignore。': 'Personal overrides and private endpoints for the current project; keep them in gitignore.',
  'Settings UI、数据库、浏览器 profile 和内置 fallback。': 'Settings, the database, the browser profile and built-in fallbacks.',
};

const PATTERNS: Array<[RegExp, (match: RegExpExecArray) => string]> = [
  [/^(\d+) 项$/, (m) => (m[1] === '1' ? '1 item' : `${m[1]} items`)],
  [/^发现 (\d+) 处本机绝对路径引用。$/, (m) => `Found ${m[1]} absolute local path reference(s).`],
  [/^发现 (\d+) 处疑似凭证或敏感字段。$/, (m) => `Found ${m[1]} possible credential(s) or sensitive field(s).`],
  [/^发现 (\d+) 处本机或内网 endpoint。$/, (m) => `Found ${m[1]} local or internal endpoint(s).`],
  [/^发现 (\d+) 处危险 shell 命令模式。$/, (m) => `Found ${m[1]} risky shell command pattern(s).`],
];

/** 单条字符串：已知中文句子换成英文，其余原样返回。 */
export function translateConfigScopeText(text: string): string {
  const exact = EXACT[text];
  if (exact !== undefined) return exact;
  for (const [pattern, render] of PATTERNS) {
    const match = pattern.exec(text);
    if (match) return render(match);
  }
  return text;
}

/** 把整份摘要里的字符串逐个过一遍 translateConfigScopeText，结构不变。 */
export function toEnglishConfigScope<T>(value: T): T {
  if (typeof value === 'string') return translateConfigScopeText(value) as T;
  if (Array.isArray(value)) return (value as unknown[]).map((item) => toEnglishConfigScope(item)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, toEnglishConfigScope(item)]),
    ) as T;
  }
  return value;
}

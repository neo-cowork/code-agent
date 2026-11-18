import { f05, f06 } from './approvalFlows';
import { f07 } from './approvalRunFlow';
import { f10 } from './attachmentFlow';
import { f08 } from './backgroundFlow';
import { f15 } from './cronFlow';
import { f16 } from './longSessionFlow';
import { f17 } from './languageFlow';
import { f09 } from './stopFlow';
import { f14 } from './memoryFlow';
import type { FlowDef } from './types';

// 地图（docs/e2e/feature-map.md）18 条 Web 流程全部有归属：
//  - 下面 CORE_FLOW_IDS 里的由本 runner 真跑（真实服务 + dogfood 模型，每晚 3 次）；
//  - SHELL_WEB_FLOWS 依赖 Tauri 壳 / 原生能力，Web 构建跑不了真的，归真机批；
//  - F18 首启引导在隔离 home 上出现不了（引导被「已配好模型」短路，见 NOT_SCRIPTTABLE_FLOWS），
//    只留 hermetic（tests/e2e/app.spec.ts 一族），真跑要等它能在隔离环境出现。
export const CORE_FLOW_IDS = ['F05', 'F06', 'F07', 'F08', 'F09', 'F10', 'F14', 'F15', 'F16', 'F17'];

export const CORE_FLOWS: FlowDef[] = [f05, f06, f07, f08, f09, f10, f14, f15, f16, f17];

/** surface: shell 的 7 条：Web 构建跑不了真的，每条一句原因（地图索引第 9 行的约定）。 */
export const SHELL_WEB_FLOWS: ReadonlyArray<{ id: string; reason: string }> = [
  { id: 'F01', reason: '写系统日历走原生 EventKit，Web 构建没有这条能力' },
  { id: 'F02', reason: '改系统日历走原生 EventKit，Web 构建没有这条能力' },
  { id: 'F03', reason: '删系统日历 + 撤销走原生 EventKit，Web 构建没有这条能力' },
  { id: 'F04', reason: '读系统日历走原生 EventKit，Web 构建没有这条能力' },
  { id: 'F11', reason: '托管浏览器窗口是壳能力，Web 构建跑不了' },
  { id: 'F12', reason: '浏览器人工接管是壳能力，Web 构建跑不了' },
  { id: 'F13', reason: '会议录音要麦克风 / 系统音频采集，Web 构建跑不了' },
];

/**
 * 首启引导（F18）在 neo-realrun 隔离 home 上无法出现：引导入口 openModelOnboardingIfNeeded
 * 先问 checkApiKeyConfigured，隔离 home 由 neo-realrun 预写好 dogfood 模型的 key（writeConfig），
 * 一定返回 true，引导被短路；不预写 key 则第一条消息就没有可用模型。即使借产品自带的
 * CODE_AGENT_E2E_FORCE_MODEL_ONBOARDING_AFTER 钩子把这一步强翻成 false，未登录（隔离 home 没有
 * Supabase 凭据）会先弹注册/登录弹窗而不是引导。真跑证据见证据档 F18 节（截图 + 代码路径）。
 */
export const NOT_SCRIPTTABLE_FLOWS: ReadonlyArray<{ id: string; reason: string }> = [
  { id: 'F18', reason: '隔离 home 上模型已预配好，首启引导被 checkApiKeyConfigured 短路，无法在不改产品代码的情况下出现' },
];

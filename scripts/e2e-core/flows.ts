import { f05, f06 } from './approvalFlows';
import { f10 } from './attachmentFlow';
import { f08 } from './backgroundFlow';
import { f14 } from './memoryFlow';
import type { FlowDef } from './types';

// 前五条：地图里已有真跑证据的 web 流程。地图没有点名「核心 5 条」，这是任务书起草者/工人定的选择；
// 其余 web 流程（F07 F09 F15–F18）由后续单补。
export const CORE_FLOW_IDS = ['F05', 'F06', 'F08', 'F10', 'F14'];

export const CORE_FLOWS: FlowDef[] = [f05, f06, f08, f10, f14];

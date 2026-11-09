// ============================================================================
// builtinJobDisplay —— 内置维护定时任务在 UI 层的本地化名称、描述与动作文案映射。
//
// 数据库中仍保留英文原值（不改存储、不跑迁移、不改 host 注册点字符串）；
// renderer 在展示面（列表行、详情、侧栏下次运行、时间能力面板）按 tag 映射为用户可读文案。
// ============================================================================

import type { CronJobDefinition } from '@shared/contract';
import { MEMORY_CONSOLIDATION } from '@shared/constants';
import type { Language } from '../../../i18n';

// Light Memory 的 tag 来自前后端共享常量 MEMORY_CONSOLIDATION.JOB_TAG；
// Dream 与 Distill 两个定时任务有意未接线（定义在 src/host/services/memory/dreamScheduler.ts
// 与 src/host/services/skills/distillScheduler.ts，不在 @shared/constants 中，且 renderer
// 不能跨边界 import src/host），因此这里保留字面量作防御性展示覆盖。
const DREAM_CRON_JOB_TAG = 'dream-memory-consolidation';
const DISTILL_CRON_JOB_TAG = 'distill-workflow-packaging';

export interface BuiltinJobDisplay {
  name: string;
  description: string;
  actionLabel: string;
}

type BuiltinJobTag =
  | typeof MEMORY_CONSOLIDATION.JOB_TAG
  | typeof DREAM_CRON_JOB_TAG
  | typeof DISTILL_CRON_JOB_TAG;

const BUILTIN_ZH_COPY: Record<BuiltinJobTag, BuiltinJobDisplay> = {
  [MEMORY_CONSOLIDATION.JOB_TAG]: {
    name: '记忆整理',
    description: '定期整理你的记忆文件，合并重复内容，不会丢失信息。',
    actionLabel: '整理记忆',
  },
  [DREAM_CRON_JOB_TAG]: {
    name: '回顾沉淀',
    description: '定期回顾最近的对话，把经过核对的长期信息写进记忆。',
    actionLabel: '回顾对话',
  },
  [DISTILL_CRON_JOB_TAG]: {
    name: '流程提炼',
    description: '定期回顾最近的对话，把反复出现的做法整理成可复用的命令或技能草稿。',
    actionLabel: '提炼流程',
  },
};

const BUILTIN_EN_COPY: Record<BuiltinJobTag, BuiltinJobDisplay> = {
  [MEMORY_CONSOLIDATION.JOB_TAG]: {
    name: 'Memory cleanup',
    description: 'Regularly tidies your memory files and merges duplicates without losing information.',
    actionLabel: 'Memory consolidation',
  },
  [DREAM_CRON_JOB_TAG]: {
    name: 'Conversation review',
    description: 'Regularly reviews recent conversations and saves verified long-term information to memory.',
    actionLabel: 'Review conversations',
  },
  [DISTILL_CRON_JOB_TAG]: {
    name: 'Workflow refinement',
    description: 'Regularly reviews recent conversations and turns repeated approaches into reusable command or skill drafts.',
    actionLabel: 'Distill workflows',
  },
};

function findBuiltinTag(tags?: string[]): BuiltinJobTag | null {
  if (!tags || tags.length === 0) return null;
  for (const tag of tags) {
    if (
      tag === MEMORY_CONSOLIDATION.JOB_TAG ||
      tag === DREAM_CRON_JOB_TAG ||
      tag === DISTILL_CRON_JOB_TAG
    ) {
      return tag;
    }
  }
  return null;
}

export function getBuiltinJobDisplay(
  job: Pick<CronJobDefinition, 'name' | 'description' | 'tags'>,
  language: Language = 'zh',
): BuiltinJobDisplay | null {
  const tag = findBuiltinTag(job.tags);
  if (!tag) return null;

  if (language === 'en') {
    return BUILTIN_EN_COPY[tag];
  }

  return BUILTIN_ZH_COPY[tag];
}

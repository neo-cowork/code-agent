// ============================================================================
// 「等你处理」状态标签的唯一文案源（N-FIX-UX-WAITING-LABEL-APPROVE-VS-CONFIRM）
//
// 规范（按语言 × 状态类）：
//   审批（approval：命令/操作待用户放行）
//     zh  等你确认          带事项：等你确认：{label}（全角冒号）
//     en  Needs your approval   带事项：Needs your approval: {label}
//   提问（question：模型在等用户回答）
//     zh  等你确认          （与审批同一个词；卡片标题已区分「批准 / 回答」）
//     en  Waiting for you
//
// 为什么 zh 审批与提问共用「等你确认」：产品负责人 2026-08-04 决策 D3 已把任务栏/概览定为
// 「等你确认」，宿主通知也是「有操作等你确认」；en 官方权限文档惯用 "needs your approval"。
// 侧栏、聊天状态行、任务栏、概览、自动化的状态标签一律从这里取，禁止再写字面量
// （由 tests/renderer/i18n/waitingOnUserLabelsGate.test.ts 静态扫描守住）。
// 不在范围：宿主通知文案、审批/提问卡片标题与按钮、「N 个操作等你确认」计数句。
// ============================================================================
export const WAITING_ON_USER_LABELS = {
  zh: {
    approval: '等你确认',
    approvalWithLabel: '等你确认：{label}',
    question: '等你确认',
  },
  en: {
    approval: 'Needs your approval',
    approvalWithLabel: 'Needs your approval: {label}',
    question: 'Waiting for you',
  },
} as const;

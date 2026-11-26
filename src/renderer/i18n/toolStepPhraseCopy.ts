// humanizeToolStep 拼中文步骤句用的模板（语言包；原文从 utils/humanizeToolStep.ts 原样迁入）。
// 英文分支的句子仍写在 humanizeToolStep.ts 里（不含中文，不进 CJK 棘轮）。
export const toolStepPhraseZh = {
  /** 待批准：「请求飞书创建日程」 */
  connectorRequest: (phrase: string) => `请求${phrase}`,
  /** 失败：「飞书创建日程未成功」 */
  connectorFailed: (phrase: string) => `${phrase}未成功`,
  /** 已完成：句首动词换成完成式——「创建了…」「发送了…」 */
  connectorCompleted: (verb: string, rest: string) => `${verb}了${rest}`,
} as const;

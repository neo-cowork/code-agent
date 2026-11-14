/** /run 被拒绝：提示词为空且没有附件。宿主只回稳定码，用户可见句子在渲染端 i18n。 */
export const PROMPT_REQUIRED = 'PROMPT_REQUIRED';
/** /run 被拒绝：请求体格式不对（非提示词缺失，多为页面过期）。渲染端给「刷新页面后重试」。 */
export const REQUEST_INVALID = 'REQUEST_INVALID';

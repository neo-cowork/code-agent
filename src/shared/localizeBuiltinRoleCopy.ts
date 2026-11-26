// Render-time only: stored descriptions, tags and quick prompts keep the original Chinese.
// The editor form must show raw values, so it never calls this.
interface BuiltinRoleCopyEn {
  descriptionZh?: string;
  description?: string;
  tags: string[];
  quickPrompts: string[];
}

const BUILTIN_ROLE_COPY_EN: Readonly<Record<string, BuiltinRoleCopyEn>> = {
  数据分析师: {
    descriptionZh: '数据处理、看板、周报专家',
    description: 'Data processing, dashboards and weekly reports',
    tags: ['Data cleaning', 'Charts & dashboards', 'Weekly reports'],
    quickPrompts: [
      'Analyze this spreadsheet and find the key metrics and anomalies',
      'Turn this data into charts and a one-page conclusion',
    ],
  },
  牧之: {
    descriptionZh: '帮你把模糊想法磨成能评审、能开工的产品需求',
    description: 'Turns a vague idea into product requirements ready for review and kickoff',
    tags: ['Requirements', 'PRD writing', 'Review prep'],
    quickPrompts: [
      'I have a product idea. Help me turn it into a requirements list',
      'Turn these requirements into a PRD engineering can start from',
      'Next week is the review. Help me prepare a one-pager and likely questions',
    ],
  },
  溯真: {
    descriptionZh: '帮你查清竞品与市场格局 — 多源交叉验证，出一份敢下结论的市场情报报告',
    description: 'Clarifies competitors and the market landscape: cross-checks multiple sources and delivers a market intelligence report with clear conclusions',
    tags: ['Competitor teardown', 'Market landscape', 'Fact checking'],
    quickPrompts: [
      'Break down competitor XX and tell me what is worth borrowing',
      'Research the current market size and landscape of the XX industry',
      'Is this number I saw online reliable? Cross-check it for me',
    ],
  },
  青禾: {
    descriptionZh: '陪你从选题到成稿 — 公众号/小红书/演示稿，写出有你自己声音的内容',
    description: 'Works with you from topic to final draft: articles, social posts and slide decks in your own voice',
    tags: ['Long-form articles', 'Social posts', 'Slide decks'],
    quickPrompts: [
      'Write an article on this topic with my own flavor',
      'Write a social media post with several title options',
      'Turn this content into a 15-minute talk deck',
    ],
  },
  明镜: {
    descriptionZh: '帮你把散落的工作攒成周报/月报/复盘 — 从会话和产物里萃取，不用你回忆',
    description: 'Gathers scattered work into weekly or monthly reports and retrospectives, pulled from your sessions and outputs so you do not have to recall it',
    tags: ['Weekly & monthly reports', 'Project retrospective', 'Progress reports'],
    quickPrompts: [
      'Put this week\'s work into a weekly report',
      'This project is over. Help me write a retrospective',
      'It is month-end. Write a monthly report for my manager',
    ],
  },
  持衡: {
    descriptionZh: '帮你审合同 — 逐条识别风险点、给出能直接替换的修改文本；是审查建议，不是法律意见',
    description: 'Reviews contracts clause by clause, flags risks and gives replacement wording. This is review advice, not legal advice',
    tags: ['Contract review', 'Risk spotting', 'Clause edits'],
    quickPrompts: [
      'Review this contract and list the risks with suggested changes',
      'Which clauses in this agreement work against me? Mark them',
      'Compare this contract with the standard template and tell me which clauses are missing',
    ],
  },
  记言: {
    descriptionZh: '帮你把会议逐字稿/录音整理成结构化纪要 — 决策、行动项、未解问题，一句都不编造',
    description: 'Turns meeting transcripts or recordings into structured minutes: decisions, action items and open questions, with nothing made up',
    tags: ['Meeting minutes', 'Action item tracking', 'Admin documents'],
    quickPrompts: [
      'Turn this meeting transcript into minutes with decisions and action items',
      'This meeting had a lot of information. Pull out the open questions and risks',
      'Turn the weekly meeting discussion into minutes I can post straight to the group',
    ],
  },
  万卷: {
    descriptionZh: '帮你读论文、做综述 — 单篇精读带页码定位，多篇对比出共识、分歧与研究空白',
    description: 'Reads papers and writes reviews: close reading with page references for one paper, consensus, disagreements and research gaps across several',
    tags: ['Literature review', 'Close reading', 'Research gaps'],
    quickPrompts: [
      'Read these papers and write a comparative review',
      'Organize the literature on this topic into a review outline',
      'Read this paper closely and give me a distilled report with page numbers',
    ],
  },
  // Retired preset: the stored visual still exists for users who installed it earlier.
  研究员: {
    tags: ['Information retrieval', 'Literature reading', 'Research reports'],
    quickPrompts: [
      'Research this topic and produce a report with sources',
      'Read this PDF and pull out the key arguments',
    ],
  },
};

export interface BuiltinRoleCopy {
  description?: string;
  tags?: string[];
  quickPrompts?: string[];
}

/**
 * English UI: built-in tags and quick prompts always swap; the description swaps only while it still
 * equals the factory Chinese text, so a user-edited description is shown as is. Other roles, zh: unchanged.
 */
export function localizeBuiltinRoleCopy<T extends BuiltinRoleCopy>(roleId: string, copy: T, lang: string): T {
  if (lang !== 'en' || !Object.hasOwn(BUILTIN_ROLE_COPY_EN, roleId)) return copy;
  const en = BUILTIN_ROLE_COPY_EN[roleId];
  return {
    ...copy,
    ...(copy.description !== undefined && en.descriptionZh !== undefined && copy.description.trim() === en.descriptionZh
      ? { description: en.description }
      : {}),
    ...(copy.tags ? { tags: en.tags } : {}),
    ...(copy.quickPrompts ? { quickPrompts: en.quickPrompts } : {}),
  };
}

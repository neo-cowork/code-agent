// ============================================================================
// confirmGenerationCost — 会话内成本确认卡（Slice A）
//
// 覆盖：文案跟随 ui.language（FB-1285，经 getConfigService().getSettings() 真实缝隙
// 注入，不传语言入参）；zh 与旧中文卡字节级一致（快照）；en 无 CJK 且读作英文文案；
// 双语言下答案匹配（confirm → true，cancel/declined/timeout/no-renderer/aborted → false）。
// ============================================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';

const promptMock = vi.hoisted(() => vi.fn());
const settingsMock = vi.hoisted(() => {
  const fn = vi.fn<() => unknown>();
  fn.mockReturnValue({ ui: { language: 'zh' } });
  return fn;
});
vi.mock('../../../../../src/host/tools/utils/userQuestionPrompt', () => ({
  promptUserInChat: promptMock,
}));
vi.mock('../../../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: settingsMock }),
}));

import { confirmGenerationCost } from '../../../../../src/host/tools/modules/design/generationCostConfirm';
import { formatCny } from '../../../../../src/shared/media/imageCost';

// CJK 表意文字/假名/谚文/CJK 标点 + 全角标点（含全角括号（））。¥(U+FFE5) 是货币符号
// 不算 CJK——en 卡片同样用 ¥ 标价（任务书 ⑥：Confirm ¥x / Cancel）。
const CJK = /[\u3000-\u303f\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af\uff01-\uff60]/;

beforeEach(() => {
  vi.clearAllMocks();
  settingsMock.mockReturnValue({ ui: { language: 'zh' } });
});

const base = { mediaLabel: 'image' as const, estCny: 0.14, detail: '2 张' };

// FB-1285 之前的中文原串快照——zh 路径必须与它字节级一致。
const ZH_SNAPSHOT = {
  header: '成本确认',
  question: '本次生成视频将消耗 ¥0.70（t2v · 5s · 通义万相 文生视频），是否继续？',
  confirmLabel: '确认 ¥0.70',
  confirmDescription: '确认并开始生成，将产生上述费用',
  cancelLabel: '取消',
  cancelDescription: '不生成，不产生费用',
  notifyTitle: '生成成本确认',
};

const EN_INPUT = {
  mediaLabel: 'video' as const,
  estCny: 0.7,
  detail: 't2v · 5s · wan2.7-t2v',
  sessionId: 's1',
};

describe('confirmGenerationCost — en 卡片（ui.language=en）', () => {
  it('①卡片 header/question/选项 label+description/notify.title 全英文且无 CJK', async () => {
    settingsMock.mockReturnValue({ ui: { language: 'en' } });
    promptMock.mockResolvedValue({ status: 'no-renderer' });
    await confirmGenerationCost(EN_INPUT);
    // 语言经真实 getConfigService().getSettings() 缝隙读入，不是语言入参。
    expect(settingsMock).toHaveBeenCalled();
    const [questions, opts] = promptMock.mock.calls[0];
    expect(questions[0].header).toBe('Cost confirmation');
    expect(questions[0].question).toBe('Generating this video will cost ¥0.70 (t2v · 5s · wan2.7-t2v). Continue?');
    expect(questions[0].options[0].label).toBe('Confirm ¥0.70');
    expect(questions[0].options[0].description).toBe('Confirm and start generating; the cost above will be charged');
    expect(questions[0].options[1].label).toBe('Cancel');
    expect(questions[0].options[1].description).toBe("Don't generate; no charge");
    expect(opts.notify.title).toBe('Generation cost confirmation');
    expect(opts.notify.body).toBe(questions[0].question);
    for (const s of [
      questions[0].header,
      questions[0].question,
      questions[0].options[0].label,
      questions[0].options[0].description,
      questions[0].options[1].label,
      questions[0].options[1].description,
      opts.notify.title,
      opts.notify.body,
    ]) {
      expect(s).not.toMatch(CJK);
    }
  });

  it('①image/slideImages 键映射英文名词（slideImages 复数 → these）', async () => {
    settingsMock.mockReturnValue({ ui: { language: 'en' } });
    promptMock.mockResolvedValue({ status: 'no-renderer' });
    await confirmGenerationCost({ mediaLabel: 'image', estCny: 0.14, detail: '2 images · wanx-t2i' });
    expect(promptMock.mock.calls[0][0][0].question).toBe('Generating this image will cost ¥0.14 (2 images · wanx-t2i). Continue?');
    await confirmGenerationCost({ mediaLabel: 'slideImages', estCny: 0.56, detail: '6 images · gpt-image-2' });
    expect(promptMock.mock.calls[1][0][0].question).toBe('Generating these slide images will cost ¥0.56 (6 images · gpt-image-2). Continue?');
  });

  it('①en 明细后缀用半角括号且前置空格', async () => {
    settingsMock.mockReturnValue({ ui: { language: 'en' } });
    promptMock.mockResolvedValue({ status: 'no-renderer' });
    await confirmGenerationCost({ mediaLabel: 'video', estCny: 0.7 });
    expect(promptMock.mock.calls[0][0][0].question).toBe('Generating this video will cost ¥0.70. Continue?');
  });
});

describe('confirmGenerationCost — zh 卡片（快照字节级不变）', () => {
  it('②ui.language=zh → 与 FB-1285 前的中文卡字节级一致', async () => {
    promptMock.mockResolvedValue({ status: 'no-renderer' });
    await confirmGenerationCost({ mediaLabel: 'video', estCny: 0.7, detail: 't2v · 5s · 通义万相 文生视频' });
    const [questions, opts] = promptMock.mock.calls[0];
    expect(questions[0].header).toBe(ZH_SNAPSHOT.header);
    expect(questions[0].question).toBe(ZH_SNAPSHOT.question);
    expect(questions[0].options[0].label).toBe(ZH_SNAPSHOT.confirmLabel);
    expect(questions[0].options[0].description).toBe(ZH_SNAPSHOT.confirmDescription);
    expect(questions[0].options[1].label).toBe(ZH_SNAPSHOT.cancelLabel);
    expect(questions[0].options[1].description).toBe(ZH_SNAPSHOT.cancelDescription);
    expect(opts.notify.title).toBe(ZH_SNAPSHOT.notifyTitle);
    expect(opts.notify.body).toBe(questions[0].question);
  });

  it('②settings 读取抛异常 → 兜底中文，同一快照', async () => {
    settingsMock.mockImplementation(() => {
      throw new Error('config unavailable');
    });
    promptMock.mockResolvedValue({ status: 'no-renderer' });
    await confirmGenerationCost({ mediaLabel: 'video', estCny: 0.7, detail: 't2v · 5s · 通义万相 文生视频' });
    const [questions, opts] = promptMock.mock.calls[0];
    expect(questions[0].header).toBe(ZH_SNAPSHOT.header);
    expect(questions[0].question).toBe(ZH_SNAPSHOT.question);
    expect(questions[0].options[0].label).toBe(ZH_SNAPSHOT.confirmLabel);
    expect(questions[0].options[1].label).toBe(ZH_SNAPSHOT.cancelLabel);
    expect(opts.notify.title).toBe(ZH_SNAPSHOT.notifyTitle);
  });

  it('卡片含 ¥ 成本 + 确认/取消两选项（image 键）', async () => {
    promptMock.mockResolvedValue({ status: 'no-renderer' });
    await confirmGenerationCost(base);
    const [questions] = promptMock.mock.calls[0];
    expect(questions).toHaveLength(1);
    expect(questions[0].question).toContain(formatCny(0.14));
    expect(questions[0].options).toHaveLength(2);
    expect(questions[0].options[0].label).toContain(formatCny(0.14)); // 确认 ¥0.14
    expect(questions[0].options[1].label).toBe('取消');
  });
});

describe('confirmGenerationCost — 双语言答案匹配', () => {
  const INPUT = { mediaLabel: 'video' as const, estCny: 0.7, detail: 't2v · 5s · m' };

  it('③答卡片下发的确认 label → true；答取消 label → false（en/zh 各跑一遍）', async () => {
    for (const language of ['en', 'zh'] as const) {
      settingsMock.mockReturnValue({ ui: { language } });
      promptMock.mockClear();
      // 先拿卡片真实下发的 header/label（答案与卡片同源），再作为回答回填。
      promptMock.mockResolvedValue({ status: 'no-renderer' });
      await confirmGenerationCost(INPUT);
      const [q] = promptMock.mock.calls[0][0];

      promptMock.mockResolvedValue({
        status: 'answered',
        response: { requestId: 'x', answers: { [q.header]: q.options[0].label } },
      });
      expect(await confirmGenerationCost(INPUT)).toBe(true);

      promptMock.mockResolvedValue({
        status: 'answered',
        response: { requestId: 'x', answers: { [q.header]: q.options[1].label } },
      });
      expect(await confirmGenerationCost(INPUT)).toBe(false);

      // 数组形态的答案同样按同源 label 匹配。
      promptMock.mockResolvedValue({
        status: 'answered',
        response: { requestId: 'x', answers: { [q.header]: [q.options[0].label] } },
      });
      expect(await confirmGenerationCost(INPUT)).toBe(true);
    }
  });

  it('③declined / timeout / no-renderer / aborted → false（en/zh 各跑一遍）', async () => {
    for (const language of ['en', 'zh'] as const) {
      settingsMock.mockReturnValue({ ui: { language } });
      for (const status of ['timeout', 'no-renderer', 'aborted'] as const) {
        promptMock.mockResolvedValue({ status });
        expect(await confirmGenerationCost(INPUT)).toBe(false);
      }
      promptMock.mockResolvedValue({
        status: 'declined',
        response: { requestId: 'x', declined: true },
      });
      expect(await confirmGenerationCost(INPUT)).toBe(false);
      promptMock.mockResolvedValue({ status: 'answered', response: undefined });
      expect(await confirmGenerationCost(INPUT)).toBe(false);
    }
  });

  it('③异源答案（en 卡收到 zh 键/中文 label）→ false', async () => {
    settingsMock.mockReturnValue({ ui: { language: 'en' } });
    promptMock.mockResolvedValue({
      status: 'answered',
      response: { requestId: 'x', answers: { 成本确认: `确认 ${formatCny(0.7)}` } },
    });
    expect(await confirmGenerationCost(INPUT)).toBe(false);
  });
});

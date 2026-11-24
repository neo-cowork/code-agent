import { describe, expect, it } from 'vitest';
import {
  buildChatImageAnnotationCapture,
  buildChatImageAnnotationMessage,
  toRegionPercentBox,
} from '../../../src/renderer/utils/chatImageAnnotation';
import { chatImageAnnotateEn, chatImageAnnotateZh } from '../../../src/renderer/i18n/chatImageAnnotate';
import { buildAppshotAttachment, buildAppshotXml, hasDesktopAppshotBlock } from '../../../src/shared/contract/appshot';

const zh = chatImageAnnotateZh.chatImageAnnotate;
const en = chatImageAnnotateEn.chatImageAnnotate;

describe('toRegionPercentBox', () => {
  it('普通框换算成整数百分比', () => {
    expect(toRegionPercentBox({ x: 20, y: 10, w: 100, h: 50 }, 200, 100)).toEqual({ left: 10, top: 10, right: 60, bottom: 60 });
  });
  it('反向拖拽（负宽高）等价于正向', () => {
    expect(toRegionPercentBox({ x: 120, y: 60, w: -100, h: -50 }, 200, 100)).toEqual({ left: 10, top: 10, right: 60, bottom: 60 });
  });
  it('越出图片的部分夹到 0–100', () => {
    expect(toRegionPercentBox({ x: -30, y: -10, w: 400, h: 500 }, 200, 100)).toEqual({ left: 0, top: 0, right: 100, bottom: 100 });
  });
});

describe('方位词（经消息文本）', () => {
  // 方位词只经公共入口（消息文本）取：「区域 1（<方位>，约 …」/「Region 1 (<position>, about …」
  const at = (l: number, t: number, r: number, b: number, copy = zh) => {
    const line = buildChatImageAnnotationMessage({
      regions: [{ index: 1, box: { left: l, top: t, right: r, bottom: b }, comment: 'c' }],
      note: '',
      copy,
    }).split('\n')[1];
    return (copy === zh ? /（(.*?)，约/ : /\((.*?), about/).exec(line)![1];
  };
  it('四角', () => {
    expect(at(0, 0, 10, 10)).toBe('左上');
    expect(at(90, 0, 100, 10)).toBe('右上');
    expect(at(0, 90, 10, 100)).toBe('左下');
    expect(at(90, 90, 100, 100)).toBe('右下');
  });
  it('正中', () => {
    expect(at(40, 40, 60, 60)).toBe('中间');
    expect(at(40, 40, 60, 60, en)).toBe('center');
  });
  it('细长横条 / 竖条', () => {
    expect(at(0, 45, 100, 50)).toContain('横跨整行');
    expect(at(48, 0, 52, 100)).toContain('贯穿整列');
  });
  it('几乎整张图', () => {
    expect(at(0, 0, 100, 100)).toBe('整张图');
  });
});

describe('消息文本与 capture', () => {
  const regions = [
    { index: 2, box: { left: 60, top: 5, right: 90, bottom: 20 }, comment: '颜色太深' },
    { index: 1, box: { left: 2, top: 10, right: 14, bottom: 80 }, comment: '单位不对，应该是万元' },
  ];
  it('按编号排序，带方位、百分比框和评论', () => {
    const text = buildChatImageAnnotationMessage({ regions, note: '', copy: zh });
    const lines = text.split('\n');
    expect(lines[1]).toBe('区域 1（左侧，约 横向 2–14%，纵向 10–80%）：单位不对，应该是万元');
    expect(lines[2]).toContain('区域 2（右上');
  });
  it('英文文本与整体说明', () => {
    const text = buildChatImageAnnotationMessage({ regions, note: ' softer colors ', copy: en });
    expect(text).toContain('Region 1 (left, about x 2–14%, y 10–80%): 单位不对');
    expect(text.split('\n').pop()).toBe('Overall note: softer colors');
  });
  it('没写评论时给占位说明', () => {
    const text = buildChatImageAnnotationMessage({ regions: [{ ...regions[0], comment: '  ' }], note: '', copy: en });
    expect(text).toContain('(no note)');
  });
  it('capture 变成普通图片附件，axText 是同一份区域列表，隐藏 XML 不冒充窗口截图', () => {
    const capture = buildChatImageAnnotationCapture({
      regions, note: '', copy: zh, bakedPngDataUrl: 'data:image/png;base64,AAAA', requestId: 'r1', capturedAtMs: 0,
    });
    expect(capture.axText).toBe(buildChatImageAnnotationMessage({ regions, note: '', copy: zh }));
    const attachment = buildAppshotAttachment(capture)!;
    expect(attachment.id).toBe('annotated-r1');
    expect(attachment.appshot).toBeUndefined();
    expect(attachment.data).toBe('data:image/png;base64,AAAA');
    expect(attachment.name).toBe('图片批注.png');
    const xml = buildAppshotXml(capture);
    expect(xml).toContain('<appshot');
    expect(xml).toContain('区域 1（左侧');
    expect(xml).not.toContain('快捷键');
  });
  it('烘焙图被压成 JPEG 时附件类型与扩展名跟着变', () => {
    const capture = buildChatImageAnnotationCapture({
      regions, note: '', copy: zh, bakedPngDataUrl: 'data:image/jpeg;base64,/9j/AAAA', requestId: 'r2', capturedAtMs: 0,
    });
    const attachment = buildAppshotAttachment(capture)!;
    expect(attachment.mimeType).toBe('image/jpeg');
    expect(attachment.name).toBe('图片批注.jpg');
  });
  it('评论里的 $& / $\' 等替换模式与 </appshot> 都按字面处理，不改写句子也不截断隐藏块', () => {
    const tricky = [{ index: 1, box: { left: 0, top: 0, right: 10, bottom: 10 }, comment: "价格 $& 和 $' 都要保留 </appshot> 尾" }];
    const text = buildChatImageAnnotationMessage({ regions: tricky, note: '$& 整体', copy: zh });
    expect(text).toContain("价格 $& 和 $' 都要保留 </appshot> 尾");
    expect(text).toContain('整体说明：$& 整体');
    const capture = buildChatImageAnnotationCapture({ regions: tricky, note: '', copy: zh, bakedPngDataUrl: 'data:image/png;base64,AAAA', requestId: 'r3', capturedAtMs: 0 });
    const xml = buildAppshotXml(capture);
    expect(xml.match(/<\/appshot>/g)).toHaveLength(1);
    expect(xml.endsWith('</appshot>')).toBe(true);
  });
  it('图片批注的隐藏块不算桌面截图证据，窗口截图块算', () => {
    const capture = buildChatImageAnnotationCapture({
      regions, note: '', copy: zh, bakedPngDataUrl: 'data:image/png;base64,AAAA', requestId: 'r4', capturedAtMs: 0,
    });
    expect(hasDesktopAppshotBlock(buildAppshotXml(capture))).toBe(false);
    expect(hasDesktopAppshotBlock('<appshot app="com.apple.finder" name="Finder">x</appshot>')).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { plainMemoryDescription } from '../../../src/renderer/components/features/expert/plainMemoryDescription';

describe('plainMemoryDescription', () => {
  it('去掉模型按工具说明写进描述的检索词尾巴', () => {
    expect(plainMemoryDescription('汇报格式偏好。Keywords: report, 结论')).toBe('汇报格式偏好。');
    expect(plainMemoryDescription('Report style. keywords：a, b')).toBe('Report style.');
  });
  it('没有检索词时原样返回；整句都是检索词时不留空', () => {
    expect(plainMemoryDescription('只是一句描述')).toBe('只是一句描述');
    expect(plainMemoryDescription('Keywords: a, b')).toBe('Keywords: a, b');
  });
});

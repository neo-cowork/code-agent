import { describe, expect, it } from 'vitest';
import { presentReplyBody } from '../../src/shared/replyBodyPresentation';

describe.each(['zh', 'en'] as const)('system reply projection (%s)', (language) => {
  it('keeps prose and deduplicates protocol reasons behind one Why note', () => {
    const raw = 'Report ready.<decision>report</decision><rationale>Review the summary.</rationale><rationale>Review the summary.</rationale>';
    const reply = presentReplyBody(raw, language);
    expect(reply.text).toBe('Report ready.');
    expect(reply.rationale).toBe('Review the summary.');
    expect(reply.technicalDetails).toContain('<decision>report</decision>');
  });
  it('does not flash partially streamed control tags', () => {
    for (const suffix of ['<dec', '<decision>', '<decision>report', '```wake_proposals\n{']) {
      expect(presentReplyBody(`Report ready.${suffix}`, language).text).toBe('Report ready.');
    }
    expect(presentReplyBody('Use the file named <summary>.', language).text).toBe('Use the file named <summary>.');
  });
});

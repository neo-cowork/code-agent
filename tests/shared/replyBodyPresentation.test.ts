import { describe, expect, it } from 'vitest';
import { presentReplyBody } from '../../src/shared/replyBodyPresentation';

describe.each(['zh', 'en'] as const)('system reply projection (%s)', (language) => {
  it('keeps prose and deduplicates protocol reasons behind one Why note', () => {
    const raw = 'Report ready.<decision>report</decision><rationale>Review the summary.</rationale><rationale>Review the summary.</rationale>';
    const reply = presentReplyBody(raw, language, { protocol: 'wake' });
    expect(reply.text).toBe('Report ready.');
    expect(reply.rationale).toBe('Review the summary.');
    expect(reply.technicalDetails).toContain('<decision>report</decision>');
  });
  it('does not flash partially streamed control tags', () => {
    for (const suffix of ['<dec', '<decision>', '<decision>report', '```wake_proposals\n{']) {
      const separator = suffix.startsWith('```') ? '\n' : '';
      expect(presentReplyBody(`Report ready.${separator}${suffix}`, language, { protocol: 'wake', isStreaming: true }).text).toBe('Report ready.');
    }
    expect(presentReplyBody('Use the file named <summary>.', language).text).toBe('Use the file named <summary>.');
  });

  it.each(['decision', 'rationale', 'evidence', 'cron_event_decision'])('preserves ordinary prompt-writing content containing %s', (tag) => {
    for (const raw of [`Use <${tag}>the instructions</${tag}> then continue.`, `Use <${tag}> then keep the entire final answer.`]) {
      const reply = presentReplyBody(raw, language);
      expect(reply.text).toBe(raw);
      expect(reply.technicalDetails).toBeUndefined();
      expect(reply.rationale).toBeUndefined();
      expect(presentReplyBody(raw, language, { isStreaming: true }).text).toBe(raw);
    }
  });

  it.each(['decision', 'rationale', 'evidence', 'cron_event_decision'])('preserves unfinished %s in finalized protocol messages', (tag) => {
    const raw = `Report ready.<${tag}>Keep all remaining final prose.`;
    const protocol = tag === 'cron_event_decision' ? 'cron' : 'wake';
    expect(presentReplyBody(raw, language, { protocol }).text).toBe(raw);
    expect(presentReplyBody(raw, language, { protocol, isStreaming: true }).text).toBe('Report ready.');
  });

  it.each([
    '`<rationale>template reason</rationale>`',
    '``Use `<evidence>` here`` and continue.',
    '```xml\n<decision>template</decision>\n<rationale>reason</rationale>\n<evidence>facts</evidence>\n```',
    '~~~xml\n<rationale>template</rationale>\n~~~',
    '````markdown\n```wake_proposals\n<evidence>example</evidence>\n```\n````',
    '```xml\n<rationale>unfinished example\n',
  ])('preserves Markdown code inside a protocol reply: %s', (code) => {
    const raw = `Template:\n\n${code}\n\nEnd of answer.`;
    expect(presentReplyBody(raw, language, { protocol: 'wake' }).text).toBe(raw);
    expect(presentReplyBody(raw, language, { protocol: 'wake', isStreaming: true }).text).toBe(raw);
  });

  it('keeps code while projecting real controls in the same reply', () => {
    const raw = 'Use `<rationale>` here.\n\n<decision>report</decision><rationale>Review `notes.md`.</rationale>';
    const reply = presentReplyBody(raw, language, { protocol: 'wake' });
    expect(reply.text).toBe('Use `<rationale>` here.');
    expect(reply.rationale).toBe('Review `notes.md`.');
    expect(reply.technicalDetails).not.toContain('Use `<rationale>`');
  });

  it('projects only the controls for the selected protocol', () => {
    const raw = '<rationale>User template</rationale>\n<cron_event_decision id="event" action="ignore">No action.</cron_event_decision>';
    expect(presentReplyBody(raw, language, { protocol: 'cron' }).text).toBe('<rationale>User template</rationale>');
    expect(presentReplyBody(raw, language, { protocol: 'wake' }).text).toContain('<cron_event_decision');
  });

  it('preserves cron control examples in code while removing the actual event decision', () => {
    const code = '`<cron_event_decision>`\n\n~~~xml\n<cron_event_decision>Example</cron_event_decision>\n~~~';
    const raw = `${code}\n<cron_event_decision id="event" action="ignore">No action.</cron_event_decision>`;
    expect(presentReplyBody(raw, language, { protocol: 'cron' }).text).toBe(code);
  });

  it.each(['<dec', '<rationale kind='])('keeps finalized partial tag syntax: %s', (suffix) => {
    const raw = `Template: ${suffix}`;
    expect(presentReplyBody(raw, language, { protocol: 'wake' }).text).toBe(raw);
  });

  it('keeps proposal examples and finalized unfinished proposal fences', () => {
    const raw = 'Template:\n```wake_proposals\n{"title":"Example"}\n```';
    expect(presentReplyBody(raw, language).text).toBe(raw);
    expect(presentReplyBody(raw, language, { protocol: 'wake' }).text).toBe('Template:');
    const unfinished = 'Template:\n```wake_proposals\n{"title":';
    expect(presentReplyBody(unfinished, language, { protocol: 'wake' }).text).toBe(unfinished);
    expect(presentReplyBody(unfinished, language, { protocol: 'wake', isStreaming: true }).text).toBe('Template:');
  });
});

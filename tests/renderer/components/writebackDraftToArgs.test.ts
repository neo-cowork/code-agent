import { describe, expect, it } from 'vitest';
import { draftFromArgs, draftToArgs } from '../../../src/renderer/components/PermissionDialog/WritebackFields';

const original = { calendar: '工作', title: '周会', start_ms: 1_700_000_000_000, location: '3F' };

describe('draftToArgs optional string fields', () => {
  it('does not invent an empty notes field the original call never had', () => {
    const args = draftToArgs('calendar_create_event', draftFromArgs('calendar_create_event', original), original);
    expect(args).not.toHaveProperty('notes');
    expect(args).toMatchObject({ title: '周会', location: '3F' });
  });

  it('sends notes the user typed', () => {
    const draft = { ...draftFromArgs('calendar_create_event', original), notes: '带上季度报表\n第二行' };
    expect(draftToArgs('calendar_create_event', draft, original)).toMatchObject({ notes: '带上季度报表\n第二行' });
  });

  it('still sends an empty string when the user clears a value that existed', () => {
    const draft = { ...draftFromArgs('calendar_create_event', original), location: '' };
    expect(draftToArgs('calendar_create_event', draft, original)).toMatchObject({ location: '' });
  });

  it('without original keeps the previous behaviour (every string field is sent)', () => {
    expect(draftToArgs('calendar_create_event', draftFromArgs('calendar_create_event', original))).toHaveProperty('notes', '');
  });
});

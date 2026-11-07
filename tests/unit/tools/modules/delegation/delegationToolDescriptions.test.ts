import { describe, expect, it } from 'vitest';

import { delegateSessionSchema } from '../../../../../src/host/tools/modules/delegation/delegateSession.schema';
import { listSessionCandidatesSchema } from '../../../../../src/host/tools/modules/delegation/listSessionCandidates.schema';

describe('cross-session delegation tool descriptions', () => {
  it('requires an explicit target and task before binding, otherwise asks instead of guessing', () => {
    expect(delegateSessionSchema.description).toContain('singles out exactly one listed candidate');
    expect(delegateSessionSchema.description).toContain('supplies task text');
    expect(delegateSessionSchema.description).toContain('do not call delegate_session; call AskUserQuestion first');
    expect(delegateSessionSchema.description).toContain('create_new is never a fallback for ambiguity');
    expect(listSessionCandidatesSchema.description).toContain('not a user choice or permission to bind');
    expect(listSessionCandidatesSchema.description).toContain('Never guess among similar candidates');
    expect(listSessionCandidatesSchema.description).toContain('does not single out exactly one candidate, call AskUserQuestion');
  });
});

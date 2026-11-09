import { describe, expect, it } from 'vitest';
import { isSurfaceExecutionEventV1 } from '../../../src/shared/contract/surfaceExecution';
import {
  compactSurfaceExecutionMetadata,
  projectLegacyBrowserComputerResultToSurfaceEventV1,
} from '../../../src/shared/utils/surfaceExecutionProjection';
import { buildSurfaceExecutionProjectionV1 } from '../../../src/renderer/utils/surfaceExecutionProjection';
import { redactSurfaceExecutionValue } from '../../../src/shared/utils/surfaceExecutionRedaction';

describe('legacy browser/computer Surface event projection', () => {
  it('keeps the renderer projection identical after compacting observation refs', () => {
    const target = {
      kind: 'browser' as const,
      browserInstanceId: 'browser-1',
      windowRef: 'window-1',
      tabRef: 'tab-1',
      documentRevision: 'document-1',
    };
    const metadata = {
      surfaceSessionId: 'surface-1',
      surfaceObservationV1: {
        version: 1,
        stateId: 'state-1',
        target,
        providerGeneration: 'provider-1',
        observedAt: 100,
        expiresAt: 30_100,
        elementRefs: [{
          kind: 'browser-element' as const,
          ref: 'ref-1',
          stateId: 'state-1',
          tabRef: 'tab-1',
          documentRevision: 'document-1',
          backendNodeId: 1,
        }],
        evidenceAssetIds: ['dom-1'],
        redactionStatus: 'clean' as const,
      },
      surfaceExecutionEventsV1: [projectLegacyBrowserComputerResultToSurfaceEventV1({
        eventId: 'event-1',
        sequence: 1,
        sessionId: 'surface-1',
        runId: 'run-1',
        agentId: 'agent-1',
        toolName: 'browser_action',
        arguments: { action: 'get_dom_snapshot' },
        result: { success: true },
        target,
        startedAt: 100,
        completedAt: 200,
      })],
    };
    const project = (value: Record<string, unknown>) => buildSurfaceExecutionProjectionV1({
      conversationId: 'conversation-1',
      compatibility: [{
        conversationId: 'conversation-1',
        runId: 'run-1',
        agentId: 'agent-1',
        surfaceSessionId: 'surface-1',
        toolResults: [{ toolCallId: 'tool-1', success: true, metadata: value }],
      }],
    });

    expect(project(metadata)).toEqual(project(compactSurfaceExecutionMetadata(metadata)));
  });

  it('keeps legacy identity and proof refs while projecting a readable browser event', () => {
    const event = projectLegacyBrowserComputerResultToSurfaceEventV1({
      eventId: 'trace-1',
      sequence: 7,
      sessionId: 'surface-session-1',
      runId: 'run-1',
      agentId: 'agent-a',
      toolName: 'browser_action',
      arguments: { action: 'screenshot', engine: 'managed' },
      result: {
        success: true,
        metadata: {
          browserComputerProof: {
            evidenceRefs: [{ id: 'evidence-shot-1' }],
          },
          browserComputerEvidenceCard: {
            status: 'observed',
            summary: 'Observed via analysis',
          },
        },
      },
      startedAt: 10,
      completedAt: 20,
    });

    expect(isSurfaceExecutionEventV1(event)).toBe(true);
    expect(event).toMatchObject({
      sequence: 7,
      sessionId: 'surface-session-1',
      runId: 'run-1',
      agentId: 'agent-a',
      surface: 'browser',
      phase: 'observe',
      status: 'succeeded',
      evidenceRefs: ['evidence-shot-1'],
      observation: { verdict: 'pass' },
    });
  });

  it('projects browser-scoped legacy computer actions onto the browser surface', () => {
    const event = projectLegacyBrowserComputerResultToSurfaceEventV1({
      eventId: 'trace-2',
      sequence: 1,
      sessionId: 'surface-session-2',
      runId: 'run-2',
      agentId: 'agent-b',
      toolName: 'computer_use',
      arguments: { action: 'smart_click', selector: '#save' },
      result: { success: true },
      startedAt: 10,
      completedAt: 20,
    });
    expect(event.surface).toBe('browser');
    expect(event.operation?.risk).toBe('browser_action');
  });

  it('redacts secret keys, inline credentials, and the canary before persistence', () => {
    const value = redactSurfaceExecutionValue({
      authToken: 'relay-token-raw',
      nested: {
        note: 'Authorization: Bearer abc.def and surface-secret-canary-do-not-leak',
        cookie: 'session=abc',
      },
    });
    const serialized = JSON.stringify(value);
    expect(serialized).not.toContain('relay-token-raw');
    expect(serialized).not.toContain('abc.def');
    expect(serialized).not.toContain('surface-secret-canary-do-not-leak');
    expect(serialized).not.toContain('session=abc');
  });
});

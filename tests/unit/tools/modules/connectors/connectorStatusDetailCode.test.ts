import { describe, expect, it } from 'vitest';
import { formatConnectorStatusOutput } from '../../../../../src/host/tools/modules/connectors/connectorStatusText';

describe('get_status text keeps cause + fix hint from detailCode', () => {
  it('calendar restricted tells the model the Connectors page cannot fix it', () => {
    const out = formatConnectorStatusOutput('calendar', { connected: false, detailCode: 'calendar_restricted', capabilities: [] });
    expect(out).toContain('restricted by the system');
    expect(out).toContain('cannot fix this from the Connectors page');
    expect(out).not.toMatch(/authorized on the Connectors page/);
    expect(out).toContain('nothing they can change');
  });
  it('calendar write-only and denied point at System Settings', () => {
    const wo = formatConnectorStatusOutput('calendar', { connected: false, detailCode: 'calendar_write_only', capabilities: [] });
    expect(wo).toContain('Full Access');
    const dn = formatConnectorStatusOutput('calendar', { connected: false, detailCode: 'calendar_denied', capabilities: [] });
    expect(dn).toContain('System Settings');
    expect(dn).not.toMatch(/authorized on the Connectors page/);
  });
  it('mail automation denied points at Automation settings', () => {
    const out = formatConnectorStatusOutput('mail', { connected: false, detailCode: 'automation_not_authorized', capabilities: [] });
    expect(out).toContain('Automation');
  });
});

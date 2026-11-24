import { describe, expect, it } from 'vitest';
import { formatConnectorStatus } from '../../../../../src/host/tools/modules/connectors/connectorStatusText';

describe('get_status text keeps cause + fix hint from detailCode', () => {
  it('calendar restricted tells the model the Connectors page cannot fix it', () => {
    const { output, guidance } = formatConnectorStatus('calendar', { connected: false, detailCode: 'calendar_restricted', capabilities: [] });
    expect(output).toContain('restricted by the system');
    expect(output).toContain('cannot fix this from the Connectors page');
    expect(guidance).not.toMatch(/authorized on the Connectors page/);
    expect(guidance).toContain('nothing they can change');
    expect(guidance).toContain('Do not send them to the Connectors page');
  });
  it('calendar write-only and denied point at System Settings', () => {
    const { output: wo } = formatConnectorStatus('calendar', { connected: false, detailCode: 'calendar_write_only', capabilities: [] });
    expect(wo).toContain('Full Access');
    const { output: dn, guidance: dnGuidance } = formatConnectorStatus('calendar', { connected: false, detailCode: 'calendar_denied', capabilities: [] });
    expect(dn).toContain('System Settings');
    expect(dnGuidance).not.toMatch(/authorized on the Connectors page/);
  });
  it('mail automation denied points at Automation settings', () => {
    const { output: out } = formatConnectorStatus('mail', { connected: false, detailCode: 'automation_not_authorized', capabilities: [] });
    expect(out).toContain('Automation');
  });
});

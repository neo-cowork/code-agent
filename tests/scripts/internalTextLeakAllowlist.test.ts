import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadAndValidateAllowlist } from '../../scripts/ci/internal-text-leak-gate.mjs';
import allowlist from '../../scripts/lib/internal-text-leak-allowlist.json';

const ALLOWLIST_REL_PATH = 'scripts/lib/internal-text-leak-allowlist.json';
const allowlistPath = path.resolve(__dirname, '../..', ALLOWLIST_REL_PATH);

const RETIRED_STALE_REASONS = new Set([
  'N-FIX-CRON-RUN-RAW-ID-AS-NAME',
  'N-FIX-CRON-EVENT-DECISION-ENGLISH-RAW-ID',
]);

describe('scripts/lib/internal-text-leak-allowlist.json', () => {
  it('parses cleanly and assigns every entry a non-unowned ticket owner without duplicates or retired stale reasons', () => {
    const entries = loadAndValidateAllowlist(allowlistPath);
    expect(entries).toEqual(allowlist);

    const seenKeys = new Set<string>();
    const nonRendererPaths: string[] = [];
    const duplicateKeys: string[] = [];
    const unownedEntries: string[] = [];
    const missingTicketPrefix: string[] = [];
    const retiredReasonEntries: string[] = [];

    for (const entry of entries) {
      if (!entry.file.startsWith('src/renderer/')) {
        nonRendererPaths.push(entry.file);
      }

      const key = `${entry.file}|${entry.rule}|${entry.sample.replace(/\s+/g, ' ').trim()}`;
      if (seenKeys.has(key)) {
        duplicateKeys.push(key);
      }
      seenKeys.add(key);

      if (/\bunowned\b/i.test(entry.reason)) {
        unownedEntries.push(`${entry.file} [${entry.rule}]: ${entry.reason}`);
      }
      if (!/^[A-Z]+-[A-Z0-9-]+(?:\b|$)/.test(entry.reason)) {
        missingTicketPrefix.push(`${entry.file} [${entry.rule}]: ${entry.reason}`);
      }
      if (RETIRED_STALE_REASONS.has(entry.reason)) {
        retiredReasonEntries.push(`${entry.file} [${entry.rule}]: ${entry.reason}`);
      }
    }

    expect(nonRendererPaths).toEqual([]);
    expect(duplicateKeys).toEqual([]);
    expect(unownedEntries).toEqual([]);
    expect(missingTicketPrefix).toEqual([]);
    expect(retiredReasonEntries).toEqual([]);
  });
});

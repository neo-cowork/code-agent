import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SLOTLESS_FALLBACK_PROVIDER_ID = 'custom-tokenrhythm';
export const DEFAULT_DOGFOOD_MODEL_FILE = path.join(os.homedir(), '.ship', 'grab', 'realrun-dev-model');
const UNAVAILABLE = 'verification environment unavailable';

function clean(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readFirstLine(file) {
  try {
    return clean(readFileSync(file, 'utf8').split(/\r?\n/, 1)[0]);
  } catch {
    return undefined;
  }
}

/**
 * Provider order: --provider flag > NEO_VERIFY_PROVIDER > first line of the dogfood
 * model file > custom-tokenrhythm. Model override: --model flag > NEO_VERIFY_MODEL_ID.
 * (NEO_VERIFY_MODEL is the stdout line name, deliberately not read here.)
 */
export function resolveSlotlessSelection({ provider, model, env = process.env, dogfoodFile = DEFAULT_DOGFOOD_MODEL_FILE } = {}) {
  return {
    providerId: clean(provider) ?? clean(env.NEO_VERIFY_PROVIDER) ?? readFirstLine(dogfoodFile) ?? SLOTLESS_FALLBACK_PROVIDER_ID,
    modelOverride: clean(model) ?? clean(env.NEO_VERIFY_MODEL_ID),
  };
}

export const FALLBACK_SELECTION = { providerId: SLOTLESS_FALLBACK_PROVIDER_ID };

export function isFallbackSelection(selection) {
  return !selection || selection.providerId === SLOTLESS_FALLBACK_PROVIDER_ID;
}

export function missingProviderMessage(providerId) {
  return `source config is missing provider ${providerId} (${UNAVAILABLE})`;
}

export function missingKeyMessage(providerId) {
  return `source config has no usable key for provider ${providerId} (${UNAVAILABLE})`;
}

/**
 * Key of a non-fallback provider: the source data dir's secure store (apikey.<id>,
 * selective read-only), else a plain apiKey string on the source provider.
 */
export async function readSelectedProviderKey(providerId, sourceProvider, sourceDataDir, readCredentials) {
  let read = readCredentials;
  if (!read) {
    ({ readModelCredentialsFromDataDir: read } = await import('../../src/host/services/core/secureStorage.ts'));
  }
  const stored = read(sourceDataDir)?.[`apikey.${providerId}`];
  if (typeof stored === 'string' && stored.trim()) return stored.trim();
  if (typeof sourceProvider?.apiKey === 'string' && sourceProvider.apiKey.trim()) return sourceProvider.apiKey.trim();
  throw new Error(missingKeyMessage(providerId));
}

export function maskVerifyKey(value) {
  if (typeof value !== 'string' || value.length < 8) throw new Error('cannot mask an invalid verification key');
  if (value.startsWith('sk_tr_') && value.length >= 10) return `sk_tr_…${value.slice(-4)}`;
  return `${value.slice(0, 3)}…${value.slice(-4)}`;
}

/** Staged key for the selection: fallback uses the dogfood TR key, others the source store. Fails before any spawn. */
export async function resolveSlotlessProviderKey(selection, sourceConfig, sourceDataDir, tokenRhythmKey) {
  const sourceProvider = sourceConfig?.models?.providers?.[selection.providerId];
  if (!sourceProvider || typeof sourceProvider !== 'object') throw new Error(missingProviderMessage(selection.providerId));
  if (isFallbackSelection(selection)) return tokenRhythmKey;
  return readSelectedProviderKey(selection.providerId, sourceProvider, sourceDataDir);
}

/** Consumes `--provider <id>` / `--model <id>` at args[index]; returns the flag name+value or undefined. */
export function parseProviderFlag(args, index) {
  const flag = args[index];
  if (flag !== '--provider' && flag !== '--model') return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires an id`);
  return { flag, value };
}

export function maskTokenRhythmKey(value) {
  if (typeof value !== 'string' || !value.startsWith('sk_tr_') || value.length < 10) {
    throw new Error('cannot mask invalid NEO_DOGFOOD_TR_KEY');
  }
  return `sk_tr_…${value.slice(-4)}`;
}

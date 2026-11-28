import { installLogPath } from './layout';
import type { LibreOfficeRuntimeError, LibreOfficeRuntimeErrorCode } from './types';

/**
 * Typed blocker for callers that run inside another tool (preview, render review) and cannot park: the binary was asked
 * for before the managed copy finished installing. Carries the ADR-090 blocker identity; it is not an EnvBlockedError,
 * so the enclosing tool keeps its ordinary failure path and nothing is re-issued.
 */
export class LibreOfficeNotReadyError extends Error {
  readonly class = 'runtime_missing' as const;
  readonly target = 'libreoffice' as const;
  readonly code = 'LIBREOFFICE_RUNTIME_INSTALLING' as const;
  constructor() {
    super('The PPT converter is still being prepared, so nothing was converted. Ask again once it is ready.');
    this.name = 'LibreOfficeNotReadyError';
  }
}

function runtimeError(
  root: string,
  code: LibreOfficeRuntimeErrorCode,
  message: string,
  retryable: boolean,
): LibreOfficeRuntimeError {
  return { code, message, retryable, logPath: installLogPath(root) };
}

export function offlineError(root: string): LibreOfficeRuntimeError {
  return runtimeError(
    root,
    'LIBREOFFICE_RUNTIME_OFFLINE',
    'LibreOffice could not be downloaded because the official source and mirror are unreachable. Check the network and try again.',
    true,
  );
}

export function checksumError(root: string): LibreOfficeRuntimeError {
  return runtimeError(
    root,
    'LIBREOFFICE_RUNTIME_INSTALL_FAILED',
    'LibreOffice download verification failed. The downloaded file was removed; try again.',
    true,
  );
}

export function installFailedError(root: string): LibreOfficeRuntimeError {
  return runtimeError(
    root,
    'LIBREOFFICE_RUNTIME_INSTALL_FAILED',
    'LibreOffice installation did not finish. See the install log and try again.',
    true,
  );
}

export function unsupportedError(root: string): LibreOfficeRuntimeError {
  return runtimeError(
    root,
    'LIBREOFFICE_RUNTIME_UNSUPPORTED',
    'The managed LibreOffice runtime is supported on macOS only.',
    false,
  );
}

const STORAGE_KEY = 'code-agent-model-onboarding-skipped';

export function hasSkippedModelOnboarding(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function skipModelOnboarding(): void {
  try {
    localStorage.setItem(STORAGE_KEY, '1');
  } catch {
    // The current wizard still stays dismissed.
  }
}

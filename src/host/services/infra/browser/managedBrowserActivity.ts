// Transient work can own a browser before a Surface binding pins its lease.
// Count overlapping/nested operations so one completion cannot unprotect another.
const activeOperations = new WeakMap<object, number>();

export function hasManagedBrowserActivity(browser: object): boolean {
  return activeOperations.has(browser);
}

export async function withManagedBrowserActivity<T>(browser: object, operation: () => Promise<T>): Promise<T> {
  activeOperations.set(browser, (activeOperations.get(browser) ?? 0) + 1);
  try {
    return await operation();
  } finally {
    const remaining = (activeOperations.get(browser) ?? 1) - 1;
    if (remaining > 0) activeOperations.set(browser, remaining);
    else activeOperations.delete(browser);
  }
}

import { detectScreenshotFailureCause as detectSharedScreenshotFailureCause } from '../../permissions/envAssist/screenshotFailureCause';

/** Retain the existing vision entry point; permission classification has one implementation. */
export function detectScreenshotFailureCause(args: Parameters<typeof detectSharedScreenshotFailureCause>[0]): ReturnType<typeof detectSharedScreenshotFailureCause> {
  return detectSharedScreenshotFailureCause(args);
}

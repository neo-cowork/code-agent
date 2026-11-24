import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';

export interface AtomicMemoryWriteOptions {
  validate?: (content: string) => void;
  createOnly?: boolean;
}

/**
 * Write a memory-owned text file without exposing a partially-written target.
 * Validation runs against the fsynced temporary file before the final rename.
 * Invalid temporary files are retained beside the target with a `.corrupt-*`
 * suffix so a failed write cannot poison the active memory set and remains
 * auditable for repair.
 */
export async function atomicWriteMemoryText(
  filePath: string,
  content: string,
  options: AtomicMemoryWriteOptions = {},
): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );

  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(content, 'utf-8');
    await handle.sync();
    await handle.close();
    handle = null;

    const readback = await fs.readFile(temporaryPath, 'utf-8');
    options.validate?.(readback);
    if (options.createOnly) {
      // A hard link publishes the complete file atomically and fails if the name is taken.
      await fs.link(temporaryPath, filePath);
      await fs.unlink(temporaryPath);
    } else {
      await fs.rename(temporaryPath, filePath);
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    const failure = error as NodeJS.ErrnoException;
    if (options.createOnly && failure.code === 'EEXIST' && failure.syscall === 'link') {
      await fs.unlink(temporaryPath);
      throw error;
    }
    const quarantinePath = `${filePath}.corrupt-${Date.now()}`;
    await fs.rename(temporaryPath, quarantinePath).catch(() => undefined);
    throw error;
  }
}

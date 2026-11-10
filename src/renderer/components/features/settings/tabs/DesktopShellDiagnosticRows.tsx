import React from 'react';
import { Copy } from 'lucide-react';
import { IconButton } from '../../../primitives';
import { copyPathToClipboard } from '../../../../utils/platform';
import type { DesktopShellDiagnosticRow } from './UpdateSettings.helpers';

interface DesktopShellDiagnosticRowsProps {
  rows: DesktopShellDiagnosticRow[];
  copyPathLabel: string;
}

export function DesktopShellDiagnosticRows({ rows, copyPathLabel }: DesktopShellDiagnosticRowsProps) {
  return (
    <div className="mt-3 grid gap-2 text-xs">
      {rows.map((row) => (
        <div key={row.key ?? row.label} className="flex items-start justify-between gap-3">
          <span className="shrink-0 text-zinc-500">{row.label}</span>
          <div className="min-w-0 flex items-center justify-end gap-1 text-right text-zinc-400">
            <span className="min-w-0 break-all">{row.value}</span>
            {row.copyValue && (
              <IconButton
                aria-label={copyPathLabel}
                title={copyPathLabel}
                icon={<Copy />}
                size="sm"
                variant="ghost"
                onClick={() => void copyPathToClipboard(row.copyValue ?? '')}
              />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

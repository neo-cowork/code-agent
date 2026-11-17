import React, { useState } from 'react';
import { Plus } from 'lucide-react';
import type { MemoryEntry, MemoryEntryCreateResult } from '@shared/contract/memory';
import { Button, Select, Textarea } from '../../../primitives';
import { MEMORY_ENTRY_ADD_COPY } from '../../../../i18n/memoryEntryAdd';

type AddKind = 'user' | 'feedback' | 'project' | 'reference';
const ADD_KINDS: AddKind[] = ['user', 'feedback', 'project', 'reference'];

interface SubmitResponse {
  success: boolean;
  data?: MemoryEntryCreateResult;
  error?: string;
}

export const MemoryEntryAddForm: React.FC<{
  language: 'zh' | 'en';
  disabled?: boolean;
  projectPath?: string | null;
  submit: (request: { content: string; kind: AddKind; projectPath?: string | null }) => Promise<SubmitResponse>;
  onCreated: (entry: MemoryEntry, duplicate: boolean) => void | Promise<void>;
}> = ({ language, disabled, projectPath, submit, onCreated }) => {
  const copy = MEMORY_ENTRY_ADD_COPY[language];
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState('');
  const [kind, setKind] = useState<AddKind>('user');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const close = () => {
    setOpen(false);
    setContent('');
    setKind('user');
    setNotice(null);
  };

  const save = async () => {
    if (!content.trim()) {
      setNotice(copy.emptyContent);
      return;
    }
    setSaving(true);
    setNotice(null);
    const response = await submit({ content, kind, projectPath: kind === 'project' ? projectPath : null });
    setSaving(false);
    if (response.success && response.data) {
      await onCreated(response.data.entry, response.data.duplicate);
      close();
      return;
    }
    setNotice(response.error?.includes('MEMORY_CREATE_EMPTY') ? copy.emptyContent : copy.failed);
  };

  if (!open) {
    return (
      <div className="flex justify-end border-b border-zinc-800 px-3 py-2">
        <Button
          variant="secondary"
          size="sm"
          leftIcon={<Plus className="h-3.5 w-3.5" />}
          disabled={disabled}
          onClick={() => setOpen(true)}
          data-testid="memory-entry-add-open"
        >
          {copy.button}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2 border-b border-zinc-800 px-3 py-3" data-testid="memory-entry-add-form">
      <div className="text-xs font-medium text-zinc-300">{copy.title}</div>
      <Textarea
        value={content}
        onChange={(event) => setContent(event.target.value)}
        placeholder={copy.placeholder}
        minRows={3}
        aria-label={copy.title}
        data-testid="memory-entry-add-content"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={kind}
          onChange={(event) => setKind(event.target.value as AddKind)}
          options={ADD_KINDS.map((value) => ({ value, label: copy.kinds[value] }))}
          aria-label={copy.typeLabel}
          selectSize="sm"
          fullWidth={false}
          data-testid="memory-entry-add-kind"
        />
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={close} disabled={saving}>{copy.cancel}</Button>
          <Button
            size="sm"
            loading={saving}
            disabled={saving || !content.trim()}
            onClick={save}
            data-testid="memory-entry-add-save"
          >
            {saving ? copy.saving : copy.save}
          </Button>
        </div>
      </div>
      {notice && <div className="text-xs text-badge-danger" data-testid="memory-entry-add-notice">{notice}</div>}
    </div>
  );
};

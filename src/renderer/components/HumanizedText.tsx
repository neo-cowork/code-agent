import React from 'react';
import { humanizeInternalText } from '@shared/humanizeInternalText';
import { useI18n } from '../hooks/useI18n';

/** Keep raw runtime text available only behind an explicit details disclosure. */
export function HumanizedText({ text }: { text: string }) {
  const { language } = useI18n();
  const presentation = humanizeInternalText(text, language);
  return <>
    {presentation.text}
    {presentation.collapseIntoDetails && (
      <details className="mt-1 text-xs font-normal">
        <summary className="cursor-pointer">{presentation.collapseIntoDetails.label}</summary>
        <pre className="whitespace-pre-wrap break-words">{presentation.collapseIntoDetails.details}</pre>
      </details>
    )}
  </>;
}

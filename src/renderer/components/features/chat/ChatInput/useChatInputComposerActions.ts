import { useCallback } from 'react';
import type React from 'react';
import type { MessageAttachment } from '@shared/contract';
import type { SpeechTranscribeResult } from '@shared/contract';
import type { ConversationVoiceInputMetadata } from '@shared/contract/conversationEnvelope';
import { UI } from '@shared/constants';
import { useI18n } from '../../../../hooks/useI18n';
import { toast } from '../../../../hooks/useToast';
import { mergeAttachments } from './attachmentDedupe';
import type { InputAreaRef } from './InputArea';

type VoiceInputContextValue = {
  anchor: string;
  metadata: ConversationVoiceInputMetadata;
} | null;

export interface UseChatInputComposerActionsParams {
  processFile: (file: File) => Promise<MessageAttachment | null>;
  inputAreaRef: React.RefObject<InputAreaRef | null>;
  setIsUploading: (uploading: boolean) => void;
  setAttachments: React.Dispatch<React.SetStateAction<MessageAttachment[]>>;
  setValue: React.Dispatch<React.SetStateAction<string>>;
  setVoiceInputContext: React.Dispatch<React.SetStateAction<VoiceInputContextValue>>;
}

/**
 * ChatInput 的附件 / 语音动作单元：
 * 文件选择、图片粘贴、附件移除、语音转写回填。
 * 纯结构性抽取自 index.tsx，零行为改动。
 */
export function useChatInputComposerActions(params: UseChatInputComposerActionsParams) {
  const {
    processFile,
    inputAreaRef,
    setIsUploading,
    setAttachments,
    setValue,
    setVoiceInputContext,
  } = params;
  const { t } = useI18n();

  const appendAttachments = useCallback((incoming: MessageAttachment[], cap: number) => {
    if (incoming.length === 0) return;
    setAttachments((prev) => {
      const result = mergeAttachments(prev, incoming, cap);
      if (result.skippedCount > 0) {
        toast.show('warning', t.chatInput.attachmentAlreadyAdded.replace('{name}', result.duplicates[0]?.incoming.name ?? ''));
      }
      return result.attachments;
    });
  }, [setAttachments, t.chatInput.attachmentAlreadyAdded]);

  // 处理文件选择
  const handleFileSelect = async (files: FileList) => {
    setIsUploading(true);
    try {
      const newAttachments: MessageAttachment[] = [];
      for (const file of Array.from(files)) {
        const attachment = await processFile(file);
        if (attachment) newAttachments.push(attachment);
      }
      appendAttachments(newAttachments, UI.MAX_ATTACHMENTS_FILE_SELECT);
    } finally {
      setIsUploading(false);
    }
  };

  // 处理图片粘贴（如微信截图）
  const handleImagePaste = useCallback(async (file: File) => {
    setIsUploading(true);
    try {
      const attachment = await processFile(file);
      if (attachment) appendAttachments([attachment], UI.MAX_ATTACHMENTS_FILE_SELECT);
    } finally {
      setIsUploading(false);
    }
  }, [processFile, appendAttachments, setIsUploading]);

  // 移除附件
  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  // 语音输入回调 - 追加到现有文本
  const handleVoiceTranscript = useCallback((text: string, result?: SpeechTranscribeResult) => {
    const transcript = text.trim();
    if (transcript) {
      const rawTranscript = result?.rawText?.trim();
      setValue(prev => {
        const current = prev.trimEnd();
        if (!current) return transcript;
        return `${current}\n\n${transcript}`;
      });
      setVoiceInputContext({
        anchor: transcript.slice(0, 64),
        metadata: {
          inputSource: 'voice',
          asrEngine: result?.engine,
          language: result?.language,
          model: result?.model,
          durationMs: result?.durationMs,
          audioDurationSeconds: result?.audioDurationSeconds,
          transcriptionMode: result?.engine === 'groq' ? 'cloud' : result?.engine === 'local-whisper' ? 'local' : undefined,
          transcriptChars: transcript.length,
          rawTranscriptChars: rawTranscript?.length,
          postProcessed: Boolean(rawTranscript && rawTranscript !== transcript),
          chunkCount: result?.chunkCount,
        },
      });
      // 聚焦输入框
      inputAreaRef.current?.focus();
    }
  }, [inputAreaRef, setValue, setVoiceInputContext]);

  return {
    handleFileSelect,
    handleImagePaste,
    removeAttachment,
    handleVoiceTranscript,
  };
}

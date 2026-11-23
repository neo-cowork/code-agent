// 成员最终输出：正文走聊天同一套 MessageContent，超过 5 行的围栏代码（粘贴的命令输出）默认折叠。
import React from 'react';
import { MessageContent } from '../chat/MessageBubble/MessageContent';

const OUTPUT_CODE_COLLAPSE_LINES = 5;

export function MemberOutputMarkdown({ output, fallback }: { output?: string | null; fallback: string }) {
  if (!output) return <div className="font-sans text-zinc-200">{fallback}</div>;
  return (
    <div className="font-sans text-zinc-200">
      <MessageContent content={output} isStreaming={false} codeCollapseLines={OUTPUT_CODE_COLLAPSE_LINES} />
    </div>
  );
}

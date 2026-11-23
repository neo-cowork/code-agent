import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { EmptySessionArea } from '../../src/renderer/components/features/chat/SessionSwitchSkeleton';
import { MessageContent } from '../../src/renderer/components/features/chat/MessageBubble/MessageContent';
import {
  createJourneyInstrument,
  installLongTaskObserver,
  JourneyProfiler,
  markJourneyStarted,
  nextFrame,
  publishJourneyError,
  publishJourneyResult,
  waitForCommitSettlement,
} from './journey-probe-instrument';

const instrument = createJourneyInstrument();

const SESSION_A = ['Session A turn 1', 'Session A turn 2', 'Session A turn 3'];
const SESSION_B = ['Session B turn 1', 'Session B turn 2', 'Session B turn 3'];

type Phase = 'session-a' | 'hydrating' | 'session-b';

function SessionBody({ lines }: { lines: string[] }): React.ReactElement {
  return (
    <div className="flex flex-col gap-3 p-6" data-testid="session-body">
      {lines.map((line) => (
        <MessageContent key={line} content={line} />
      ))}
    </div>
  );
}

function SessionSwitchSurface(): React.ReactElement {
  const [phase, setPhase] = useState<Phase>('session-a');

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
      await nextFrame();
      if (!document.body.innerText.includes('Session A turn 1')) {
        throw new Error('session-switch: session A did not render');
      }
      setPhase('hydrating');
      await nextFrame();
      const skeleton = await waitForSkeleton();
      if (!skeleton) throw new Error('session-switch: hydration skeleton never appeared');
      setPhase('session-b');
      await nextFrame();
      if (!document.body.innerText.includes('Session B turn 1')) {
        throw new Error('session-switch: session B did not render');
      }
      if (document.querySelector('[data-testid="session-switch-skeleton"]')) {
        throw new Error('session-switch: skeleton still visible after session B');
      }
      await waitForCommitSettlement(instrument);
      if (!cancelled) {
        publishJourneyResult('session-switch', instrument, {
          from: 'session-a',
          to: 'session-b',
          skeletonAppeared: true,
          sessionBVisible: true,
        });
      }
      } catch (error) {
        publishJourneyError(error);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  const welcome = <SessionBody lines={SESSION_B} />;
  return (
    <instrument.HotProbe>
      {phase === 'session-a' ? <SessionBody lines={SESSION_A} /> : null}
      {phase !== 'session-a' ? (
        <EmptySessionArea
          isHydratingSession={phase === 'hydrating'}
          settled={phase === 'session-b'}
          welcome={welcome}
        />
      ) : null}
    </instrument.HotProbe>
  );
}

function waitForSkeleton(): Promise<HTMLElement | null> {
  const deadline = performance.now() + 1_000;
  return new Promise((resolve) => {
    const poll = () => {
      const node = document.querySelector<HTMLElement>('[data-testid="session-switch-skeleton"]');
      if (node) {
        resolve(node);
        return;
      }
      if (performance.now() >= deadline) {
        resolve(null);
        return;
      }
      window.setTimeout(poll, 20);
    };
    poll();
  });
}

function SessionSwitchJourney(): React.ReactElement {
  return (
    <JourneyProfiler id="session-switch" instrument={instrument}>
      <SessionSwitchSurface />
    </JourneyProfiler>
  );
}

// MessageContent 经 React.lazy 加载 MarkdownCore。lazy 是否已解析取决于网络/CPU：慢机器上
// chunk（或已缓存模块的 import 回调）晚于首次渲染，会多出 Suspense 恢复 commit，
// 落在 hydrating 之前或 session B 挂载之后，使 commitCount 随机 +1。
// 探针量的是会话切换本身，不是 chunk 加载竞速：先在游离 root 里渲染一条同样的
// MessageContent，等 lazy 解析完（fallback 消失），再开始计时和渲染探针子树。
async function warmUpMarkdownChunk(): Promise<void> {
  const host = document.createElement('div');
  const warmRoot = createRoot(host);
  warmRoot.render(<MessageContent content="warm-up" />);
  const deadline = performance.now() + 10_000;
  try {
    while (host.querySelector('.whitespace-pre-wrap') || !host.textContent?.includes('warm-up')) {
      if (performance.now() >= deadline) throw new Error('session-switch: markdown chunk never resolved');
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    }
  } finally {
    warmRoot.unmount();
  }
}

async function bootstrap(): Promise<void> {
  const root = document.getElementById('root');
  if (!root) throw new Error('Missing #root for session-switch journey.');
  try {
    await warmUpMarkdownChunk();
  } catch (error) {
    publishJourneyError(error);
    return;
  }
  installLongTaskObserver();
  markJourneyStarted();
  createRoot(root).render(<SessionSwitchJourney />);
}

void bootstrap();

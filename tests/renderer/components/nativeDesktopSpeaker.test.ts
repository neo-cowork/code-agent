import { describe, expect, it } from 'vitest';
import { nextAudioCaptureMode, speakerName } from '../../../src/renderer/components/features/settings/sections/nativeDesktopActivityModel';

describe('会议模式说话人图例与模式切换', () => {
  const text = { speaker: '说话人', speakerMe: '我', speakerOthers: '对方' };

  it('按声道分出的说话人显示「我 / 对方」，其余仍按编号', () => {
    expect(speakerName(1, text)).toBe('我');
    expect(speakerName(2, text)).toBe('对方');
    expect(speakerName(3, text)).toBe('说话人 3');
  });

  it('模式按钮在 会议 → 系统音频 → 麦克风 之间轮换', () => {
    expect(nextAudioCaptureMode('meeting')).toBe('system-audio');
    expect(nextAudioCaptureMode('system-audio')).toBe('microphone');
    expect(nextAudioCaptureMode('microphone')).toBe('meeting');
  });
});

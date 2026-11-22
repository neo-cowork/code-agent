// GUI 接管披露（N-CUA-HOST-GUI-DISCLOSURE）：host 在本 run 首次直接驱动某 app 界面
// 前挂的结构化披露（code=gui_takeover + app），renderer 在调用卡前渲染成一句话。
// 文案与任务书 walkthrough 对齐：点明哪个 app、为什么只能直接操作界面。
export const guiTakeoverZh = {
  disclosure: '接下来我会直接操作「{app}」的界面——这件事没有现成的连接器或网页路径可用。',
};

export const guiTakeoverEn: typeof guiTakeoverZh = {
  disclosure: "Next I'll operate {app} directly on screen — there's no connector or browser route for this.",
};

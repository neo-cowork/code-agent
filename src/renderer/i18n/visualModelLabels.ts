// 内置多模态模型（src/shared/constants/visualModels.ts 的生图/视频注册表 + 宿主内置的音乐模型）
// 带中文的显示名，按模型 id 收在这里；界面经 utils/visualModelLabel 取。
// zh 必须与注册表原文逐字相同（tests/renderer/utils/visualModelLabel.test.ts 钉住）。

export const visualModelLabelsZh = {
  visualModelLabels: {
    'wanx-t2i': '通义万相',
    'wan2.7-t2v': '通义万相 文生视频',
    'wanx2.1-i2v-turbo': '通义万相 图生视频',
    'MiniMax-Hailuo-02': '海螺 文生视频',
    'I2V-01': '海螺 图生视频',
    'veo-3.1-fast-generate-preview': 'Veo 3.1 视频（快速）',
    'veo-3.1-generate-preview': 'Veo 3.1 视频',
    'minimax-music-2.6': 'MiniMax 音乐',
  },
};

export const visualModelLabelsEn: typeof visualModelLabelsZh = {
  visualModelLabels: {
    'wanx-t2i': 'Tongyi Wanxiang',
    'wan2.7-t2v': 'Tongyi Wanxiang · text to video',
    'wanx2.1-i2v-turbo': 'Tongyi Wanxiang · image to video',
    'MiniMax-Hailuo-02': 'Hailuo · text to video',
    'I2V-01': 'Hailuo · image to video',
    'veo-3.1-fast-generate-preview': 'Veo 3.1 video (fast)',
    'veo-3.1-generate-preview': 'Veo 3.1 video',
    'minimax-music-2.6': 'MiniMax Music',
  },
};

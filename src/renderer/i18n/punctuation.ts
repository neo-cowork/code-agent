// 拼界面文字时用到的标点。中文用全角，英文用半角加空格。
// 渲染处一律 `names.join(t.punctuation.listSeparator)`、`{label}{t.punctuation.colon}`，
// 不要再手写 '、' 或 '：'——英文界面会原样露出全角标点。
export const punctuationZh = {
  punctuation: {
    listSeparator: '、',
    colon: '：',
  },
};

export const punctuationEn: typeof punctuationZh = {
  punctuation: {
    listSeparator: ', ',
    colon: ': ',
  },
};

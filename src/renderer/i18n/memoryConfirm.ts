// 全局记忆确认卡的措辞（en.ts/zh.ts 已到行数上限，单独成文件）。
// host 只给「值 + 形状」，句子都在这里。
import type { Language } from './index';

interface MemoryConfirmWords {
  remember: string;
  description: string;
  name: string;
  replaces: string;
  deleteMemory: string;
  command: string;
  path: string;
  changeFromTo: (from: string, to: string) => string;
}

const ZH: MemoryConfirmWords = {
  remember: '记住：',
  description: '说明：',
  name: '名称：',
  replaces: '这会替换一条已有的规则',
  deleteMemory: '删除（归档）这条记忆：',
  command: '执行：',
  path: '文件：',
  changeFromTo: (from, to) => `把「${from}」改成「${to}」`,
};

const EN: MemoryConfirmWords = {
  remember: 'Remember: ',
  description: 'Description: ',
  name: 'Name: ',
  replaces: 'This replaces an existing rule',
  deleteMemory: 'Delete (archive) this memory: ',
  command: 'Run: ',
  path: 'File: ',
  changeFromTo: (from, to) => `Change '${from}' to '${to}'`,
};

export function getMemoryConfirmWords(language: Language): MemoryConfirmWords {
  return language === 'en' ? EN : ZH;
}

import { toolUserLabel } from '@shared/utils/toolUserLabel';
import { roleEditReceiptZh, roleEditReceiptEn } from './roleEditReceipt';

export const receiptPresentationZh = {
  ...roleEditReceiptZh,
  receiptPresentation: {
    succeeded: '成功',
    failed: '失败',
    showDetails: '展开执行详情',
    hideDetails: '收起执行详情',
    recipientSingle: '发给 {first}',
    recipientMultiple: '发给 {first} 等 {count} 人',
    humanToolLabels: {
      connectors: {
        mail: '邮件',
        calendar: '日历',
        reminders: '提醒事项',
        tmeet: '腾讯会议',
        feishu: '飞书',
      },
      tools: {
        runCommand: toolUserLabel('bash', 'zh'),
        writeFile: toolUserLabel('write', 'zh'),
        editFile: toolUserLabel('edit', 'zh'),
        webFetch: toolUserLabel('webfetch', 'zh'),
        webSearch: toolUserLabel('websearch', 'zh'),
        readFile: toolUserLabel('read', 'zh'),
        findFiles: toolUserLabel('glob', 'zh'),
        memorySearch: toolUserLabel('memorysearch', 'zh'),
      },
      // 只读工具读取的「对象」名词（审批卡「读取{对象}」用），区别于 tools 里的动作短语。
      readObjects: {
        meetingRecords: '会议记录',
        clipboard: '剪贴板',
        memory: '记忆',
        pastConversations: '历史对话',
      },
      unknownTool: '工具',
    },
    roleCapabilityLabels: {
      readAndFindFiles: '读取和查找文件',
      writeAndEditFiles: '写入和编辑文件',
      runCommands: '运行命令',
      searchTheWeb: '联网搜索',
      openWebPages: '打开网页',
      rememberAndRecall: '记住和回想',
      otherAbility: '其他 {count} 项能力',
      otherAbilities: '其他 {count} 项能力',
      separator: '、',
    },
  },
};

export const receiptPresentationEn: typeof receiptPresentationZh = {
  ...roleEditReceiptEn,
  receiptPresentation: {
    succeeded: 'Succeeded',
    failed: 'Failed',
    showDetails: 'Show execution details',
    hideDetails: 'Hide execution details',
    recipientSingle: 'Sent to {first}',
    recipientMultiple: 'Sent to {first} and others ({count} recipients)',
    humanToolLabels: {
      connectors: {
        mail: 'Mail',
        calendar: 'Calendar',
        reminders: 'Reminders',
        tmeet: 'Tencent Meeting',
        feishu: 'Feishu',
      },
      tools: {
        runCommand: toolUserLabel('bash', 'en'),
        writeFile: toolUserLabel('write', 'en'),
        editFile: toolUserLabel('edit', 'en'),
        webFetch: toolUserLabel('webfetch', 'en'),
        webSearch: toolUserLabel('websearch', 'en'),
        readFile: toolUserLabel('read', 'en'),
        findFiles: toolUserLabel('glob', 'en'),
        memorySearch: toolUserLabel('memorysearch', 'en'),
      },
      readObjects: {
        meetingRecords: 'meeting records',
        clipboard: 'clipboard',
        memory: 'memory',
        pastConversations: 'past conversations',
      },
      unknownTool: 'Tool',
    },
    roleCapabilityLabels: {
      readAndFindFiles: 'Read and find files',
      writeAndEditFiles: 'Write and edit files',
      runCommands: 'Run commands',
      searchTheWeb: 'Search the web',
      openWebPages: 'Open web pages',
      rememberAndRecall: 'Remember and recall',
      otherAbility: '{count} other ability',
      otherAbilities: '{count} other abilities',
      separator: ', ',
    },
  },
};

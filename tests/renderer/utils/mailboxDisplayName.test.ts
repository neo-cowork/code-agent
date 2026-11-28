// 邮箱显示名（中文界面只翻译常见默认系统邮箱，其余原样；英文界面全部原样）。
// 本文件钉名字对照表和重名规则；下拉渲染见 CronMailEventFieldsMailboxNames.test.tsx，
// 摘要行见 CronEventEditor / chatInput.scheduleEventConfirm / roleRoutinesSection 各自的测试。
import { describe, expect, it } from 'vitest';
import { mailboxDisplayName, mailboxOptionLabels } from '../../../src/renderer/utils/mailboxDisplayName';

const SYSTEM_NAMES: Array<[string, string[]]> = [
  ['收件箱', ['INBOX', 'Inbox', 'inbox']],
  ['已发送', ['Sent', 'Sent Messages', 'Sent Mail', 'Sent Items']],
  ['草稿箱', ['Drafts', 'Draft']],
  ['已删除', ['Trash', 'Deleted Messages', 'Deleted', 'Deleted Items', 'Bin']],
  ['垃圾邮件', ['Junk', 'Junk Mail', 'Junk Email', 'Junk E-mail', 'Spam', 'Bulk', 'Bulk Mail']],
  ['归档', ['Archive', 'Archives', 'All Mail']],
  ['发件箱', ['Outbox']],
];

describe('mailboxDisplayName', () => {
  it.each(SYSTEM_NAMES)('zh：常见默认系统邮箱显示为「%s」', (expected, names) => {
    for (const name of names) {
      expect(mailboxDisplayName(name, 'zh'), name).toBe(expected);
      expect(mailboxDisplayName(name.toUpperCase(), 'zh'), name.toUpperCase()).toBe(expected);
      expect(mailboxDisplayName(`  ${name.toLowerCase()} `, 'zh'), `padded ${name}`).toBe(expected);
    }
  });

  it('zh：带 [Gmail]/ 或 [Google Mail]/ 前缀的系统邮箱同样翻译', () => {
    expect(mailboxDisplayName('[Gmail]/Sent Mail', 'zh')).toBe('已发送');
    expect(mailboxDisplayName('[Gmail]/All Mail', 'zh')).toBe('归档');
    expect(mailboxDisplayName('[Google Mail]/Spam', 'zh')).toBe('垃圾邮件');
    expect(mailboxDisplayName('[gmail]/trash', 'zh')).toBe('已删除');
  });

  it('zh：服务商中文名、用户自建文件夹、只是包含系统词的名字都原样返回', () => {
    for (const name of [
      '广告邮件', '病毒文件夹', '草稿箱', '垃圾邮件', 'Receipts', '工作', 'INBOX/Sent', 'Sent 2024',
      'Junk-keep', 'Archive/2023', '[Gmail]/Starred', '[Gmail]/', 'constructor', 'toString', '',
    ]) {
      expect(mailboxDisplayName(name, 'zh'), name).toBe(name);
    }
  });

  it('en：所有名字原样返回，包括系统邮箱', () => {
    for (const names of SYSTEM_NAMES.map(([, list]) => list)) {
      for (const name of names) expect(mailboxDisplayName(name, 'en'), name).toBe(name);
    }
    expect(mailboxDisplayName('[Gmail]/Sent Mail', 'en')).toBe('[Gmail]/Sent Mail');
    expect(mailboxDisplayName('广告邮件', 'en')).toBe('广告邮件');
  });
});

describe('mailboxOptionLabels', () => {
  it('zh：没有重名时系统邮箱只显示中文名，其余原样，顺序不变', () => {
    expect(mailboxOptionLabels(['INBOX', '广告邮件', '草稿箱', 'Sent Messages', 'Deleted Messages', 'Junk', 'Receipts'], 'zh'))
      .toEqual(['收件箱', '广告邮件', '草稿箱', '已发送', '已删除', '垃圾邮件', 'Receipts']);
  });

  it('zh：译名和服务商自己的中文邮箱重名时，译出的那项带上原名，原本就是中文名的那项不动', () => {
    expect(mailboxOptionLabels(['INBOX', '已发送', 'Sent Messages', 'Junk', '垃圾邮件'], 'zh'))
      .toEqual(['收件箱', '已发送', '已发送（Sent Messages）', '垃圾邮件（Junk）', '垃圾邮件']);
  });

  it('zh：两个系统邮箱译成同一个名字时两项都带原名', () => {
    expect(mailboxOptionLabels(['Trash', 'Deleted Messages', 'Drafts'], 'zh'))
      .toEqual(['已删除（Trash）', '已删除（Deleted Messages）', '草稿箱']);
  });

  it('en：从不改名，也不加括注', () => {
    const names = ['INBOX', '已发送', 'Sent Messages', 'Trash', 'Deleted Messages'];
    expect(mailboxOptionLabels(names, 'en')).toEqual(names);
  });
});

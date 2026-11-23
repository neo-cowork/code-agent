import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import type { ServerInfo } from './types';

// 网页版文件框上传的附件到不了模型（模型回「没收到文件」，实测），所以把用户的文件放进共享工作目录，
// 会话用这个目录作项目文件夹（openFolderSession）。每次尝试先清空目录，上一次的产出不污染下一次。
function resetWorkspace(server: ServerInfo): void {
  fs.mkdirSync(server.workspace, { recursive: true });
  for (const name of fs.readdirSync(server.workspace)) fs.rmSync(path.join(server.workspace, name), { recursive: true, force: true });
}

export function writeHtmlPages(server: ServerInfo): string[] {
  const pages: Array<[string, string]> = [
    ['页面1-销售周报.html', '<h1>销售周报</h1><p>本周新签 12 单，回款 86 万，重点客户 3 家已跟进。</p>'],
    ['页面2-产品周报.html', '<h1>产品周报</h1><p>本周上线 2 个功能，修复 9 个问题，下周计划发布新版本。</p>'],
    ['页面3-客服周报.html', '<h1>客服周报</h1><p>本周受理 340 个咨询，满意度 96%，主要问题集中在登录。</p>'],
  ];
  resetWorkspace(server);
  return pages.map(([name, body]) => {
    const file = path.join(server.workspace, name);
    fs.writeFileSync(file, `<!doctype html><meta charset="utf-8"><title>${name}</title>${body}`);
    return file;
  });
}

/** 华东 3 月最高：150,000；Q1 合计 华东 405,000 / 华北 310,000 / 华南 234,000。 */
export function writeSalesXlsx(server: ServerInfo): string {
  const rows = [
    ['区域', '1月', '2月', '3月'],
    ['华东', 120000, 135000, 150000],
    ['华北', 98000, 110000, 102000],
    ['华南', 70000, 76000, 88000],
  ];
  resetWorkspace(server);
  const file = path.join(server.workspace, 'q1-sales.xlsx');
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), '销售');
  XLSX.writeFile(wb, file);
  return file;
}

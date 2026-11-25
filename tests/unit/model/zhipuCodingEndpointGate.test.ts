// 静态契约门：MODEL_API_ENDPOINTS.zhipuCoding（0ki coding 中继）只允许出现在
// providerRegistryBase.ts（registry 默认端点定义处）。业务代码必须走
// resolveZhipuVisionFallbackBaseUrl / resolveProviderBaseUrl，让请求跟随
// 用户设置里的智谱 base URL，而不是把智谱 key 硬发第三方中继。
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const HOST_ROOT = path.resolve('src/host');
const ALLOWED_FILE = path.normalize('src/host/model/providerRegistryBase.ts');
// 常量引用（点/下标两种写法都算）与裸 URL 字面量同等拦截，绕写不进门。
const PATTERNS = [
  'MODEL_API_ENDPOINTS.zhipuCoding',
  "MODEL_API_ENDPOINTS['zhipuCoding']",
  'MODEL_API_ENDPOINTS["zhipuCoding"]',
  'api.0ki.cn',
];

function listTypeScriptFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(fullPath);
    return entry.isFile() && entry.name.endsWith('.ts') ? [fullPath] : [];
  });
}

// 只匹配代码表达式：整行注释（//、*、/* 开头，如 plugins/ 里的两处注释）不算命中；
// 行内其余内容原样保留，模板串里的真实引用必须被拦下。
function isCodeLine(line: string): boolean {
  const trimmed = line.trimStart();
  return !(
    trimmed.startsWith('//')
    || trimmed.startsWith('/*')
    || trimmed.startsWith('*')
  );
}

describe('zhipuCoding endpoint static contract', () => {
  it('the zhipu coding endpoint appears only in providerRegistryBase.ts', () => {
    const hits: string[] = [];
    for (const file of listTypeScriptFiles(HOST_ROOT)) {
      const rel = path.normalize(path.relative(process.cwd(), file));
      if (rel === ALLOWED_FILE) continue;
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (isCodeLine(line) && PATTERNS.some((pattern) => line.includes(pattern))) {
          hits.push(`${rel}:${index + 1}`);
        }
      });
    }
    expect(
      hits,
      `hardcoded zhipuCoding endpoint outside ${ALLOWED_FILE}:\n${hits.map((h) => `- ${h}`).join('\n')}`,
    ).toEqual([]);
  });
});

// ============================================================================
// invokeNativeCommandAction 失败处理静态门（N-FIX-FIX-...-CHAINAUDIT）
// ============================================================================
// 原生命令在打包态被 ACL 拒收时只以 rejected promise 回来；处理器静默吞掉 =
// 功能悄悄死掉（post_system_notification 漏授权已经这么死过一轮）。
// 本门用 typescript AST 扫 src/renderer 下每一处 invokeNativeCommandAction 调用，
// 为每个调用点找它的失败处理器，依次看：
//   1. 调用自身 promise 链上的 `.catch(...)` / `.then(_, onRejected)`；
//   2. 调用所在的 `.then/.catch/.finally` 回调之后、同一链条上的下一个拒收处理器
//      （`.then(cb).catch(h)` 里 cb 的 rejection 实际由 h 吞）；
//   3. 包住调用、且 try 块包含调用的最近一个 try 的 catch 子句。
// 三处都找不到处理器 = 错误沿 promise 向上传播，不算静默（忽略该点）。
// 找到处理器但体内没有 console.warn / console.error / logger.warn / logger.error
// 也没有 throw = 静默吞点，必须进下面的 SILENT_ALLOWED 显式白名单（一行理由）。
// 白名单只降不升：删掉静默点后残留的条目立刻判红，不许腐化成盲区。
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const RENDERER_ROOT = path.join(root, 'src', 'renderer');
/** 门面自身的定义文件不扫（invokeNativeCommandAction 只在这里定义，不调用）。 */
const FACADE_FILE = 'src/renderer/services/nativeCommandFacade.ts';

/**
 * 已确认的静默吞点白名单，key 为 `<repo 相对路径>::<action 名>`，值必须是一行理由。
 * 修复后不再有对应静默点的条目会判红（stale allowlist）。
 */
const SILENT_ALLOWED: Record<string, string> = {
  // useAgentHalo 不判 isNativeCommandRuntimeAvailable：web 构建里每次调用都抛
  // 'Tauri runtime not available'，agent 事件一多就把控制台刷爆；失败本来就是
  // 「光晕不显示」这一无害降级。
  'src/renderer/hooks/useAgentHalo.ts::hideAgentHalo':
    'best-effort overlay cleanup; the hook also fires in web builds where every invoke rejects (no Tauri runtime), so logging each rejection would spam the console; failure degrades to a hidden halo',
  'src/renderer/hooks/useAgentHalo.ts::setAgentHaloMode':
    'same web-build spam constraint; the mode push is cosmetic halo state and is re-issued on the next agent event',
  'src/renderer/hooks/useAgentHalo.ts::showAgentHalo':
    'web builds always reject here; the catch already rolls the halo lifecycle back to hidden, so failure degrades to no halo',
  // useSurfaceExecutionPip 有 isNativeCommandRuntimeAvailable 守卫，失败只剩
  // 打包态命令被拒；hide 是 fire-and-forget 收尾，controls 下一帧会重推。
  'src/renderer/hooks/useSurfaceExecutionPip.ts::hidePip':
    'fire-and-forget native window cleanup; a rejection means the pip is already gone or unreachable — nothing actionable',
  'src/renderer/hooks/useSurfaceExecutionPip.ts::setPipControls':
    'controls are re-pushed on every state change so a transient rejection self-heals; the serial-queue tail must stay non-fatal to keep the queue alive',
};

interface CallSite {
  file: string;
  action: string;
  line: number;
  verdict: 'propagates' | 'logged' | 'silent';
}

function rendererSourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return rendererSourceFiles(file);
    return /\.tsx?$/.test(entry.name) ? [file] : [];
  });
}

function toRel(file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}

/** `node.foo(...)`（node 是接收者）时返回属性名与整条调用，否则 undefined */
function memberCallOn(node: ts.Node): { name: string; call: ts.CallExpression } | undefined {
  const parent = node.parent;
  if (!parent || !ts.isPropertyAccessExpression(parent) || parent.expression !== node) return undefined;
  const grand = parent.parent;
  if (!grand || !ts.isCallExpression(grand) || grand.expression !== parent) return undefined;
  return { name: parent.name.text, call: grand };
}

const FUNCTION_LIKE = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.MethodDeclaration,
]);

function innermostFunction(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (FUNCTION_LIKE.has(cur.kind)) return cur as ts.FunctionLikeDeclaration;
    cur = cur.parent;
  }
  return undefined;
}

/** 从 `expr` 起沿 `expr.m1().m2()...` 找第一个拒收处理器（catch 回调或 then 第二参） */
function nextRejectionHandler(expr: ts.Node): ts.Expression | ts.CallExpression | undefined {
  let cur = expr;
  for (;;) {
    const member = memberCallOn(cur);
    if (!member) return undefined;
    if (member.name === 'catch') return member.call.arguments[0] ?? member.call;
    if (member.name === 'then' && member.call.arguments.length >= 2) return member.call.arguments[1];
    cur = member.call;
  }
}

type Handler = { node: ts.Node; via: 'own-chain' | 'chain-callback' | 'try-catch' } | 'none';

function findFailureHandler(call: ts.CallExpression): Handler {
  // 1. 调用自身链条上的拒收处理器
  const own = nextRejectionHandler(call);
  if (own) return { node: own, via: 'own-chain' };

  // 2. 调用位于 `.then/.catch/.finally(cb)` 的 cb 内部：链条上 cb 之后的下一个
  //    拒收处理器实际吞掉 cb 的 rejection（普通标识符调用 enqueue(cb) 等不算）。
  const fn = innermostFunction(call);
  if (fn && ts.isCallExpression(fn.parent)
      && fn.parent.arguments.includes(fn as ts.Expression)
      && ts.isPropertyAccessExpression(fn.parent.expression)
      && ['then', 'catch', 'finally'].includes(fn.parent.expression.name.text)) {
    const chained = nextRejectionHandler(fn.parent);
    if (chained) return { node: chained, via: 'chain-callback' };
  }

  // 3. 最近的、try 块包含调用的 try 的 catch 子句（catch/finally 块里冒出来的不算）
  let child: ts.Node = call;
  let ancestor: ts.Node | undefined = call.parent;
  while (ancestor) {
    if (ts.isTryStatement(ancestor) && ancestor.tryBlock === child && ancestor.catchClause) {
      return { node: ancestor.catchClause, via: 'try-catch' };
    }
    child = ancestor;
    ancestor = ancestor.parent;
  }
  return 'none';
}

/** 处理器体内是否带日志或再抛（穿过嵌套函数都算——该处理器确实持有了这条证据） */
function handlerCarriesEvidence(handlerBody: ts.Node): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isThrowStatement(node)) {
      found = true;
      return;
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const receiver = node.expression.expression;
      const method = node.expression.name.text;
      if (ts.isIdentifier(receiver) && (receiver.text === 'console' || receiver.text === 'logger')
          && (method === 'warn' || method === 'error')) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(handlerBody);
  return found;
}

function handlerBody(handler: ts.Node): ts.Node {
  if (ts.isCatchClause(handler)) return handler.block;
  if (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)) return handler.body;
  return handler;
}

function scanCallSites(): { sites: CallSite[]; filesScanned: number } {
  const sites: CallSite[] = [];
  const files = rendererSourceFiles(RENDERER_ROOT).filter((file) => toRel(file) !== FACADE_FILE);
  let parsed = 0;
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    if (!text.includes('invokeNativeCommandAction')) continue;
    parsed += 1;
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
          && node.expression.text === 'invokeNativeCommandAction') {
        const actionArg = node.arguments[0];
        const action = actionArg && ts.isStringLiteral(actionArg) ? actionArg.text : actionArg?.getText(source) ?? '?';
        const handler = findFailureHandler(node);
        let verdict: CallSite['verdict'];
        if (handler === 'none') verdict = 'propagates';
        else verdict = handlerCarriesEvidence(handlerBody(handler.node)) ? 'logged' : 'silent';
        sites.push({
          file: toRel(file),
          action,
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          verdict,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { sites, filesScanned: parsed };
}

describe('invokeNativeCommandAction 失败处理静态门', () => {
  const { sites, filesScanned } = scanCallSites();
  const silent = sites.filter((site) => site.verdict === 'silent');
  console.info(
    `[nativeCommandCatchTrace] parsed ${filesScanned} files, checked ${sites.length} call sites: ` +
    `${sites.filter((site) => site.verdict === 'propagates').length} propagating (no handler), ` +
    `${sites.filter((site) => site.verdict === 'logged').length} handlers carry a log/throw, ` +
    `${silent.length} silent (need allowlist)`,
  );

  it('每个静默吞点都在 SILENT_ALLOWED 里带一行理由', () => {
    const missing = silent
      .filter((site) => !SILENT_ALLOWED[`${site.file}::${site.action}`]?.trim())
      .map((site) => `${site.file}::${site.action} (line ${site.line})`);
    expect(
      missing,
      'silent invokeNativeCommandAction failure handlers — add a log/throw, or allowlist with a reason',
    ).toEqual([]);
  });

  it('白名单没有残留条目（修掉静默点后必须同步删条目）', () => {
    const silentKeys = new Set(silent.map((site) => `${site.file}::${site.action}`));
    const stale = Object.keys(SILENT_ALLOWED).filter((key) => !silentKeys.has(key));
    expect(stale, 'stale SILENT_ALLOWED entries — remove them').toEqual([]);
  });
});

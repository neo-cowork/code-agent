# Agent Neo / Code Agent

Agent Neo 是产品名，`code-agent` 是仓库历史名。这个文件主要给本仓库里的开发协作工具读取，面向浏览者的入口见 `README.md` 和 `docs/architecture/repo-map.md`。

@AGENTS.md

> 上一行把 `AGENTS.md`（给 AI 工人的硬约束：禁改边界、门与提交纪律、开工前检查清单）引进来：Claude Code 目录里有 CLAUDE.md 时不会再单独读 AGENTS.md，所以要显式引用。那些约束只在 AGENTS.md 写一份，本文件不重复。

## 本地 LLM Wiki

项目知识库采用 Karpathy 模式。它用于本地研究和协作，不要求出现在公开 GitHub 仓库里。操作规范见 `~/.claude/specs/wiki-schema.md`，使用 `/wiki` skill 操作。

| 目录 | 用途 |
|------|------|
| `wiki/` | 本地 LLM 维护的编译知识，例如概念、实体、对比、摘要 |
| `raw/` | 本地不可变源文档，例如文章、论文、竞品截图 |

公开仓库里的长期文档放在 `docs/`。如果 GitHub 上看不到 `wiki/` 或 `raw/`，按本地知识库处理即可。

## 项目上下文

当我提到 'code agent'、'ai-code-agent' 或 'coda agent' 时，指的是本地项目 `code-agent`，产品名是 Agent Neo。

本项目主要使用 TypeScript（辅以 HTML 报告和少量 JavaScript）。新文件默认 TypeScript。

**架构分层**：工程层（core: agentLoop/tools/context/hooks/security）+ 技能层（skills: PPT/Excel/数据分析）。分析功能时必须尊重这个分层。

**Workbench 语义**：提到 "workbench" 指聊天主链路的能力工作台（`ConversationEnvelope` + `InlineWorkbenchBar` + Turn Timeline），与 `TaskPanel`（sidecar 深度控制面）职责分离。聊天能完成的动作不要求先打开 TaskPanel。详见 `docs/architecture/workbench.md`（ADR-011 Chat-Native Workbench，决策表见 docs/ARCHITECTURE.md）。

## 沟通规则

- 截图/参考材料默认与当前讨论相关，不要编造独立上下文
- 简短中文指令（"帮我实现"、"继续"）→ 先检查上下文中的计划/任务列表，直接执行

## 调试指南

同一问题 2 次修复失败后，停下来从头重新分析根因。

## 技术栈

- **框架**: Tauri 2.x + React 19 + TypeScript
- **构建**: esbuild (main/preload) + Vite (renderer)
- **样式**: Tailwind CSS | **状态**: Zustand
- **AI**: Kimi K2.5（主）, 智谱/DeepSeek/OpenAI（备）, Codex CLI（沙箱+交叉验证, MCP）
- **后端**: Supabase + pgvector

## 文档导航

| 文档 | 说明 |
|------|------|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 高层设计 HLD（入口）+ 决策记录（ADR）表 |
| [docs/architecture/agent-core.md](docs/architecture/agent-core.md) | Agent 核心运行时 |
| [docs/architecture/tool-system.md](docs/architecture/tool-system.md) | 工具系统 |
| [docs/architecture/multiagent-system.md](docs/architecture/multiagent-system.md) | 混合多 Agent 架构 |
| [docs/architecture/surface-execution.md](docs/architecture/surface-execution.md) | Browser/Computer 统一执行运行时（ADR-046） |
| [docs/architecture/dynamic-workflow.md](docs/architecture/dynamic-workflow.md) | Dynamic Workflow 命令式脚本编排运行时 |
| [docs/architecture/data-storage.md](docs/architecture/data-storage.md) | 数据存储 |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | 部署配置 |
| [docs/api-reference/index.md](docs/api-reference/index.md) | API 参考 |
| [docs/releases/](docs/releases/) | 版本发布记录 |

> PRD / guides / 内部 spec 等产品策略类文档不进公开仓库；ADR 决策记录见 `docs/ARCHITECTURE.md` 的决策表。

## 常用命令

```bash
npm run build        # 构建
npm run build:web    # Web 构建（Tauri 前端）
npm run build:cli    # CLI 构建（独立于 build）
npm run typecheck    # 类型检查
npm run gates:local  # 按快到慢运行所有可在本机复现的 PR CI 门，并显式列出平台性排除
cargo tauri dev      # 开发模式（需 HTTPS_PROXY=http://127.0.0.1:7897）
cargo tauri build    # 打包 macOS（~33MB DMG）
```

## 开发规范

### 验证优先
- 修改代码后必须先验证，流程：`修改 → 验证 → 确认通过 → 通知`
- 写完功能点后立即 `npm run typecheck`，commit 前必须通过

### 提交纪律
- 每完成一个功能点立即提交，不要积攒
- **代码质量由 Claude 负责，用户不 review 代码**：用户看不懂代码、不做 diff review，禁止把审查责任推给用户。质量靠 Claude 自审 + 分层验证保证：
  - **自审（Claude 自己做，不是甩给用户）**：commit 前 `git diff --check`（拦空白错误/冲突标记残留）+ `git diff --stat` 逐文件查变更行数，行数异常的 `git diff <file>` 逐行确认；尤其 SSE/IPC 协议文件（webServer.ts、platform/）和共享类型文件
  - **分层验证（每个功能点交付前按需跑全）**：① `npm run typecheck` 必过 ② 受影响模块 targeted 测试 ③ 涉及 UI/页面走 E2E/视觉验证（/e2e）④ 高风险改动（协议/共享类型/安全/计费）用多模型对抗审查（/multi-review 或 codex-audit）
  - **向用户汇报质量证据，不贴 diff**：用自然语言说测试通过数 / 覆盖了什么 / 验证结论，让用户基于证据而非代码做判断；**汇报必须带全量测试计数**（X passed / Y failed / Z skipped，来自完整套件而非只报 targeted 子集），跑不了全量就写明跑了哪个子集、为什么；**并标注证据档位**（static-contract / hermetic-protocol / fault-injection / real-runtime，定义见 `docs/testing-evidence-classes.md`），只有结构性门+mock 单测时说明为何不需要变异验证或真机验证
- **用户只在设计决策层拍板**：架构 / 产品级选择走 ADR，用人话呈现给用户拍板；拍板后 Claude 自主推进实现 + 验证，不再要求用户看代码

### 代码品味
- 避免过度工程，只做必要的事
- 不添加未被请求的功能、注释或重构
- 三行重复代码优于一个过早抽象

### 禁止硬编码（强制）

以下值 **必须** 从 `src/shared/constants/`（barrel 目录，import 路径仍是 `src/shared/constants`）导入，禁止在业务代码中写字面量：

| 值 | 常量名 | 说明 |
|----|--------|------|
| Provider 默认值 | `DEFAULT_PROVIDER` | 禁止写 `\|\| 'deepseek'` 或 `\|\| 'moonshot'` |
| 模型默认值 | `DEFAULT_MODEL` | 禁止写 `'kimi-k2.5'` 或 `'deepseek-chat'` 作为 fallback |
| API 端点 | `MODEL_API_ENDPOINTS.*` | 禁止在 provider 中硬编码 URL |
| 超时值 | `*_TIMEOUTS.*` | 禁止写 `300000`、`30000` 等魔法数字 |
| 模型价格 | `MODEL_PRICING_PER_1M` | 禁止在多个文件中维护价格表 |
| 上下文窗口 | `CONTEXT_WINDOWS` | 禁止在多个文件中维护上下文窗口映射 |
| 视觉模型 | `ZHIPU_VISION_MODEL` | 禁止写 `'glm-4v-plus'` |
| Mermaid API | `MERMAID_INK_API` | 禁止在多个文件中定义 |
| API 版本 | `API_VERSIONS.ANTHROPIC` | 禁止写 `'2023-06-01'` |
| maxTokens 默认 | `MODEL_MAX_TOKENS.*` | 禁止散布 `8192`、`2048` |
| 目录名 | `CONFIG_DIR_NEW` (configPaths) | 禁止写 `'.code-agent'` 字面量 |
| Codex 沙箱 | `CODEX_SANDBOX.*` | 禁止写 `'codex'`、`30000` 等沙箱常量 |
| 交叉验证 | `CROSS_VERIFY.*` | 禁止写 `0.7`、`60000` 等阈值 |
| Codex 会话 | `CODEX_SESSION.*` | 禁止写 `'~/.codex/sessions'` 等路径 |
| 降级链 | `PROVIDER_FALLBACK_CHAIN` | 禁止在 modelRouter 中硬编码降级目标 |
| 时间戳更新 | 参数传入或 `?? Date.now()` | **禁止在 DB 操作中直接写 `Date.now()`**。所有写入 `updated_at` 的方法必须支持可选时间戳参数，未传时才 fallback `Date.now()`。云端同步场景必须保留远程原始时间戳 |

**新增 provider/模型/超时/价格时**，只在 `shared/constants/` 对应分组文件添加，然后引用。

**自检清单**（提交前）：
```bash
grep -rn "|| 'deepseek'" src/host/ --include="*.ts"
grep -rn "|| 'gen3'" src/host/ --include="*.ts"
grep -rn "'300000\|300_000'" src/host/ --include="*.ts"
grep -rn "Date.now()" src/host/services/core/repositories/ --include="*.ts"
```

## 快速参考

发版、本地 dogfood 打包、Dev 测试包多槽（NEO_SLOT）、renderer 热更新、`.env` 读取顺序、本地数据库的完整流程在 `docs/dev/local-dev-reference.md`，要做这几件事时先读它。几条不能踩的线留在这里：

- 正式发版只推 tag（`git push origin v<version>`），签名、公证、上传都在 CI 的 `.github/workflows/release.yml`；不要本地 `cargo tauri build`。发布说明写 `docs/releases/v<version>.md`，文案规则见上面那份文档。
- 本地 dogfood 默认打 Dev 测试包（Agent Neo Dev.app），不碰生产 Agent Neo.app；构建、安装、启动只走 `scripts/run-dev-slot.sh`，新 worktree 先 `bash scripts/worktree-bootstrap.sh <树路径>`。
- `.env` 读取命中第一个就停：`~/.code-agent-dev/.env` 存在时不会回退读生产 `~/.code-agent/.env`，Dev 包要用的 key 得复制进去。
- 本地数据库：`~/.code-agent/code-agent.db`。

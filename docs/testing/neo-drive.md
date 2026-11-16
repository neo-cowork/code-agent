# neo-drive：按元素操作、按状态等待地驱动 Agent Neo

`scripts/neo-drive.mjs` 是一个测试工具，用来替代「按截图坐标点 → 固定 sleep → 截图 → 看图判断」的验收方式。
它按元素去点（文字、`data-testid`、角色），等待都看状态（运行结束、出现需要用户处理的卡片、日志行、库里的行），
截图只在要给人看的时候才截。本机和 mini 用同一份脚本。

## 原理

- Dev 包的窗口加载的就是 `http://localhost:<8180+槽号>/`。本机直接打开这个地址的页面，会拿到页面本来就注入的本机 token（`src/web/routes/static.ts`）。
  所以无头 Chromium 打开同一个地址，用的就是同一份 renderer 包、同一个后端：EventKit 和 TCC 都算在 Dev 包进程头上。
  这条路不读钥匙串或 secure-storage，也不改 Dev 库和 config。
- 浏览器常驻：`browser start` 在后台起一个无头 Chromium（优先用 Playwright 缓存里的 headless shell，不碰日常用的 Chrome），之后每条命令通过 CDP 连上同一个页面。
  命令结束时页面不会关掉，所以在跑的 run 不会因为客户端关页被判成 interrupted。同一时刻只允许一个实例；30 分钟没有命令就自动退出（`--idle-exit-min` 可以改）。
- 辅助功能树只用在网页层够不到的地方，比如系统授权框（`UserNotificationCenter` 进程，按按钮名点）。WKWebView 的 AX 树按元素查询要整棵遍历，很慢，所以应用内的元素首选页面命令；`ax-click --deep` 留着兜底。

## 常用

```bash
# 无头：隔离数据目录 + dogfood 账号（复用 verify-slotless）
node scripts/neo-drive.mjs browser start --slotless            # 已构建过可加 --reuse-dist
node scripts/neo-drive.mjs new-session
node scripts/neo-drive.mjs send "写一段 300 字的介绍"
node scripts/neo-drive.mjs wait-idle --expect idle
node scripts/neo-drive.mjs assert-visible testid=turn-reply-actions
node scripts/neo-drive.mjs shot after
node scripts/neo-drive.mjs browser stop                         # 同时停掉隔离服务

# 场景一次跑完（自动起停浏览器），输出每步耗时 JSON
node scripts/neo-drive.mjs run scripts/neo-drive-scenarios/c-long-session-scroll-send.json --slotless

# 真机：驱动已安装的 Agent Neo Dev（槽 1；--dev=2 选槽 2）
node scripts/neo-drive.mjs run scripts/neo-drive-scenarios/a-calendar-grant.json --dev
node scripts/neo-drive.mjs quit --slot 1        # 只按信号退出（先 TERM，15 秒后 KILL），不用 osascript quit
node scripts/neo-drive.mjs install <worktree>   # 先 quit，再跑 <worktree>/scripts/tauri-install-dev.sh
node scripts/neo-drive.mjs launch
node scripts/neo-drive.mjs reset-tcc Calendar
node scripts/neo-drive.mjs ax-click "Allow Full Access" --process UserNotificationCenter
```

目标的写法：纯文本表示按可见文字找；`testid=<data-testid>`；`role=<角色>:<名称>`（名称精确匹配，比如 `role=button:允许访问日历`；按钮名带快捷键提示时用正则，比如审批卡的 `role=button:/^允许一次/`）；`css=<选择器>`。
同名的元素有多个时，取最后一个可见的，因为聊天里最新的卡片总在最后。

## 等待和断言

| 命令 | 什么时候算过 |
|---|---|
| `send` | 输入框已经清空，或者已经进入运行中（不等 run 结束） |
| `wait-idle` | 出现**新的**、还在等人处理的卡片（审批卡、环境代修卡、停车审批卡，卡里要有可点的按钮）时返回 `needs-user`；见过运行中、而且停止按钮连续 800ms 没再出现时返回 `idle`。`--grace` 是允许多久都还没开始跑，比如授权之后自动续做的那段空档 |
| `wait-text` | 页面上出现这段文字 |
| `assert-visible` | 元素整个落在视口和它的滚动容器里面，而且上、中、下三个点最上层命中的都是它自己（被输入框或浮层盖住就算不过，并报出盖住它的是谁） |
| `assert-bottom` | 消息列表离底部不超过 4px，在 `--within` 毫秒内达到就算过 |
| `wait-log` | 从上一次 `send` 时的日志位置往后，出现匹配这个正则的行（读的是 `<数据目录>/logs/*.log`） |
| `wait-db` | `sqlite3 -readonly` 查到了结果（加 `"empty": true` 就是等它变成没有结果） |

所有等待都是条件轮询加超时（默认 120 秒，`--timeout` 或步骤里的 `timeout` 可以改），不写固定 sleep。

## 场景文件

```json
{ "name": "…", "steps": [ { "do": "send", "text": "neo-drive 测试 ${ts}" }, { "do": "wait-idle", "expect": "idle" } ] }
```

`${ts}` 会被替换成这次运行的时间戳。任意一步失败后，后面只跑标了 `"always": true` 的清理步，整个场景判失败。
`click` 加 `"ifVisible": true` 表示在 timeout 之内没出现就跳过。三个基准场景放在 `scripts/neo-drive-scenarios/`。

## 在 mini 上跑

mini 上的主检出 `~/work/code-agent` 不一定是当前的 main，要先开一棵独立的树：

```bash
ssh neo-worker 'cd ~/work/code-agent && git fetch -q origin && git worktree add --detach ~/work/wt/NEO-DRIVE origin/main \
  && bash scripts/worktree-bootstrap.sh ~/work/wt/NEO-DRIVE'
ssh neo-worker 'cd ~/work/wt/NEO-DRIVE && node scripts/neo-drive.mjs run scripts/neo-drive-scenarios/c-long-session-scroll-send.json --slotless'
```

- 无头模式（`--slotless`，或者 `--url` 指向本机服务）：通过 ssh 直接就能用，不需要图形会话。
- 真机模式里，`--dev` 的页面驱动、`quit/launch/install/reset-tcc`、`wait-log/wait-db` 在 ssh 下都能用，前提是 Dev 包已经在 mini 的图形会话里运行。
  `ax-click` 和 `shot-window` 要用到 System Events 和屏幕录制，ssh 进程拿不到图形会话的辅助功能/录屏授权，要放到图形会话的终端里跑。（尚未实测，待验）

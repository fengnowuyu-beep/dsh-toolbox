# dsh-toolbox · 自用工具库

DSH 桌面端（DeepSeek Harness）的个人工具箱插件，四件事：

| 功能 | 位置 |
| --- | --- |
| **一键重启 DSH** | 窗口标题栏图标按钮（贴着系统最小化/最大化/关闭按钮左侧）+ 设置页 + 可选托盘小程序；点击后二次确认 |
| **检查桌面端更新** | 标题栏图标按钮，有更新时变绿，鼠标悬停显示「当前版本 → 最新版本」 |
| **Enter / Ctrl+Enter 发送** | 设置 → 通用里的独立一行，以及插件设置页；切换后立即生效 |
| **本对话消费金额** | 输入框下方，紧挨 DSH 自带的 token 用量胶囊 |

所有按钮都是图标（内联 SVG，无第三方图标依赖），没有文字按钮。

---

## 安装

```powershell
# 在 DSH 里：设置 → 插件 → 安装，填入目录或包名
E:/Data/Project/DeepSeekHarness/DSH-Homemade-Plugins/dsh-toolbox
```

或用命令行等价的方式（与同目录的 `dsh-windows-notify`、`dsh-text-manager` 一致）：

```jsonc
// ~/.dsh/profiles/desktop/package.json
"dependencies": {
  "dsh-toolbox": "file:E:/Data/Project/DeepSeekHarness/DSH-Homemade-Plugins/dsh-toolbox"
},
"dsh": { "profile": { "bundles": [ /* … */ "dsh-toolbox" ] } }
```

然后在 profile 目录执行 `pnpm install`。

> **改完代码要重启才生效。** 载入器会缓存已 import 的模块，`file:` 依赖虽然在
> `node_modules` 里是软链接（改文件立即指到新代码），但已加载的插件实例不会重新
> import。这正是本插件提供「重启」的原因：改完点一下标题栏的重启按钮即可。

---

## 1. 重启 DSH

### 为什么是「先起助手，再退出」

DSH 桌面端的进程结构决定了插件**不能**直接请外壳重启：

- Electron 主进程是父进程，DSH 的 Node 半边（Host）是它的 IPC 子进程；
- 主进程不对外开放插件扩展点，而且它**校验**子进程发来的每一条 IPC 消息——不认识的
  类型会被当成「Host 异常」并直接终止整个应用（`isDesktopHostEvent`）；
- 子进程自行退出时，主进程会把它当作崩溃，弹出恢复对话框，而不是重新启动。

所以插件的做法是：

1. 先以 **detached 方式**启动一个重启助手（`scripts/relaunch.ps1`），助手写出
   「就绪标记」文件；
2. Host 轮询该标记，**只有看到就绪才**结束 Electron 主进程（`process.kill(ppid)`）；
3. 主进程消失 → 子进程的 IPC 断开 → DSH 的 Node 半边执行自己的
   `shutdown(0)`，把会话日志与后台任务落盘后退出；
4. 助手等到「应用进程消失」且「HTTP 端口释放」后，重新启动同一个可执行文件。

因此不会出现「关掉起不来」：助手没就绪就直接拒绝重启并把原因报给界面。

另一个细节：主进程结束后，Host 可能还在落盘、暂时占着 HTTP 端口；助手会先等端口释放，
若仍被占用则**只**清理「与被重启的可执行文件同名」的残留进程（端口确实被别的程序占用时
它不会动手，并在日志里说明），避免新实例撞上「另一个 DSH 实例正在运行」。日志在
`~/.dsh/toolbox/logs/relaunch.log`。

**代价（界面上也如实提示）**：Electron 自己的退出收尾（窗口位置、更新日志）不会执行，
进行中的对话与后台任务会被中断；DSH 自己的数据在第 3 步已落盘。

### 关于托盘

**DSH 自带托盘图标和它的右键菜单由 Electron 外壳创建与拥有，插件无法往里加菜单项**
（没有插件扩展点，且 IPC 白名单不可扩展）。因此本插件提供的是：

- 标题栏图标按钮（默认开启）；
- 设置页里的「立即重启」；
- **可选**的「托盘小程序」（默认关闭）：一个并排的独立托盘图标，右键菜单提供同样的
  「重启 / 检查更新 / 打开」，DSH 退出时它自己消失。开启方式：设置 → 自用工具库 →
  托盘小程序。

语音之外的另一种替代路径：标题栏菜单栏（DSH 在 Windows 上注入的「应用/编辑」按钮）
里本来就有「退出」，配合任意方式重新启动即可。

---

## 2. 检查桌面端更新

- **当前版本**：Desktop 的 Node 半边拿不到 `app.getVersion()`，所以版本从安装目录读
  ——优先读 `resources/app.asar/package.json`（Electron 的 `fs` 被 asar 补丁接管后这是
  一个可读的虚拟路径），退回到自己解析 asar 头部，再退回到 `resources/app/package.json`。
- **更新源**：读 `resources/app-update.yml`（electron-builder 写给这个安装的 feed），
  按它声明的 provider/url/channel 抓 `<channel>.yml`，再用语义化比较判断是否更新。因此
  检查结果与官方更新器一致，而不是写死一个地址。
- **颜色与提示**：有更新时按钮变绿，悬停提示「当前 x → 最新 y」；点击时若有更新则交给
  官方更新弹窗（`dshDesktop.updates.open()`）执行下载安装，否则做一次静默检查。
- 后台按设置里的间隔（默认 6 小时）自动检查一次。

---

## 3. Enter / Ctrl+Enter 发送

不替换输入框，只**改写一次按键**：

- `Ctrl+Enter`（macOS 为 `⌘+Enter`）→ 阻止原事件，向编辑器重放一个**不带修饰键的
  Enter**，也就是 DSH 自己定义的「发送」；
- `Enter` → 阻止原事件，重放一个 **Shift+Enter**，也就是 DSH 自己定义的「换行」；
- `Shift+Enter`、`Alt+Enter`、输入法合成中的 Enter、非输入框的编辑器一律不碰。

这样联想词弹窗、忙碌队列（排队/插话）、输入法都继续由 DSH 自己决定。默认仍是 DSH 的
「回车发送」。

---

## 4. 本对话消费金额

显示在输入框下方、DSH 自带 token 胶囊旁边；点击展开明细（缓存命中/未命中/输出、按模型、
高峰时段样本数、价格来源与更新时间）。

- **口径与 token 计数一致**：金额由会话日志折叠而来，替换规则与 DSH 的 `tokenUsage`
  投影完全相同（同一 `(turn, step)` 覆盖、`llm/retry-started` 清空），所以金额描述的
  永远是 token 胶囊显示的那批 token。
- **按每条样本发生的时刻计价**：高峰时段（UTC 周一至周五 01:00–04:00、06:00–10:00）
  按高峰价，其余按空闲价（半价）。中国法定节假日无法自动识别，这一点在设置页有说明。
- **缓存写入**按「缓存未命中」价计费（官方价目表没有单独的缓存写入行）。
- **模型识别**：优先用消息自带的 `provider/model`，其次用当时的 `request/header` /
  `request/context`；退役别名（`deepseek-v4-flash`、`deepseek-chat`、`deepseek-reasoner`）
  映射到 `deepseek-flash`。
- **定价**（两种货币都随插件附带，可自动更新）：
  - 内置表：`deepseek-flash`、`deepseek-v4-pro` 的官方标价（人民币与美元）；
  - 「自动」（默认）：抓取 DeepSeek 官方价格页并解析那张带合并单元格的 HTML 表格，
    美元页与人民币页都抓；失败时保留上一份可用价格；
  - 「自定义 JSON 地址」：接受本插件格式，或 `{模型: {cacheHit, cacheMiss, output}}`
    （每百万 token）的简单格式；
  - 「仅内置价格」：完全离线。

价格缓存写在 `~/.dsh/toolbox/prices.json`，刷新间隔默认 168 小时。

---

## 设置

标题栏两个按钮、二次确认开关、更新检查间隔、发送键、消费金额（开关/货币/汇率/计价来源/
刷新）、托盘小程序开关，都在 **设置 → 自用工具库**；发送键同时也在 **设置 → 通用** 里
紧挨 DSH 自带的「Composer Enter」一行。

状态与路径：

```
~/.dsh/toolbox/settings.json     设置
~/.dsh/toolbox/prices.json       价格缓存
~/.dsh/toolbox/logs/             toolbox.log / relaunch.log / tray.log
```

---

## 开发

```powershell
node --test test/*.test.mjs     # 或 npm test：101 个用例，全部离线
```

| 测试 | 覆盖 |
| --- | --- |
| `test/settings.test.mjs` | 设置分层合并、越界值回退、磁盘往返、损坏文件回退 |
| `test/pricing.test.mjs` | 官方价格页解析（用抓下来的 en/zh 页面做夹具）、高峰判定、别名、换算、外部 JSON |
| `test/appinfo.test.mjs` | 版本比较（含 prerelease）、feed 地址推导、`app-update.yml` 解析、asar 读取 |
| `test/cost.test.mjs` | 折叠替换规则、重试清空、逐模型、高峰/空闲、跨币种、未定价 token |
| `test/restart.test.mjs` | 未确认/非桌面端拒绝、助手未就绪**绝不**结束应用、就绪后只安排一次退出 |
| `test/host.test.mjs` | 真实路由处理函数：回环围栏、方法校验、设置往返、更新检查、计价刷新、消费路由 |
| `test/client.test.mjs` | 浏览器半边的注册落位、字典键一致、**按键改写的全部分支**、标题栏定位、金额格式化 |

辅助脚本：

- `tools/make-icon.py` — 重新生成 `assets/icon.ico` / `icon.png`（需要 Pillow）；
- `tools/asar-walk.mjs` — 列出 `app.asar` 内的路径，用来翻查 DSH 实现。

写脚本时的两条约束（都踩过）：

- `scripts/*.ps1` **必须保持纯 ASCII**：Windows PowerShell 5.1 会把没有 BOM 的脚本按 ANSI
  解码，中文源码会直接语法错误。用户可见的文案因此放在
  `assets/tray-strings.json`（用 `-Encoding UTF8` 显式读取）。
- 助手脚本在触碰任务栏通知区**之前**先写日志，这样「托盘图标没出现」和「脚本没跑起来」
  在日志里是可区分的。

---

## English summary

`dsh-toolbox` is a DSH Desktop plugin with four features: a confirmed one-click DSH restart
(icon button in the window title bar, plus an optional companion tray icon, because the
shell's own tray menu cannot be extended by a plugin), a desktop update check that reads the
installation's own `app-update.yml` feed (green icon + current→latest tooltip), a send-key
choice (Enter vs Ctrl+Enter, implemented by rewriting one keystroke into the shell's own
submit/newline events), and a per-conversation spend readout priced from DeepSeek's published
table — shipped, peak/off-peak aware, and refreshable from the vendor's own pricing page.
`npm test` runs 101 offline specs.

## License

MIT

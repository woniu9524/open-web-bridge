---
name: owb
description: 用 owb CLI 驱动用户的真实浏览器（用户的登录态、指纹、正在看的页面）。当任务涉及打开网页、读页面内容、点击/填表、抓包分析、录制 HAR、保存登录态、hook 页面函数、模拟环境、或需要人机交接（验证码/扫码登录）时使用。
---

# Open Web Bridge (owb)

通过 `owb` 命令行驱动用户本机真实浏览器：语义快照、点击填表、网络抓包、HAR 录制、
登录态保存、页面 hook/断点、环境模拟、人机交接。所有能力都在一个 CLI 里，直接用
Bash 调用即可，无需任何客户端配置。

## 前提

`owb` 是 open-web-bridge 仓库 `owb-daemon/` 下的 bin（源码 `owb-daemon/src/cli.js`）。
用户已 `npm install` 后，用以下任一方式调用：

- `node <仓库>/owb-daemon/src/cli.js <命令>`（始终可用）
- `owb <命令>`（若已 `npm link` 或全局装）

daemon 未运行时 **CLI 会自动拉起**，无需手动 `npm start`。浏览器扩展需用户在
`chrome://extensions` 以开发者模式加载 `owb-extension/` 目录（一次性）。

## 第一步永远是 doctor

任何浏览器任务开始前，先跑无参 `owb` 自检：

```bash
node owb-daemon/src/cli.js
```

- `✓ daemon` + `✓ 扩展已连接` → 可以干活
- `✗ 扩展未连接` → 让用户点浏览器工具栏的扩展图标看状态，别急着调工具（会一直报
  NO_EXTENSION）

## 核心工作流：读 → 定位 → 操作

owb 的定位模型是**语义快照**：`owb page` 给页面可交互元素打上 `@eN` 稳定 ref，
后续 `click`/`fill` 直接引用 ref，不用猜 CSS selector。

```bash
node owb-daemon/src/cli.js open https://www.zhihu.com          # 打开页面
node owb-daemon/src/cli.js page                                # 快照，得到 @e1 @e2 …
node owb-daemon/src/cli.js fill @e3 "开源浏览器自动化"          # 填搜索框（@ 开头 = ref）
node owb-daemon/src/cli.js click @e5                           # 点搜索按钮
node owb-daemon/src/cli.js wait --url-pattern "search"         # 等结果页
node owb-daemon/src/cli.js page --mode article                # 正文提取为 markdown
```

要点：
- **ref 会失效**：页面导航或重渲染后旧 ref 报 `REF_STALE`，重新 `owb page` 取新 ref。
- **selector 也行**：不以 `@` 开头的定位参数按 CSS selector 处理，如
  `owb click ".submit-btn"`。
- **增量快照省 token**：`owb page --since-last` 只返回上次快照后的变化。
- **等待优于轮询**：需要等元素/文本/URL/网络空闲，用 `owb wait`，别写 `eval` 轮询。

## 命令组一览

`owb help` 看全部，`owb help <组>` 看组内详情。常用：

| 组 | 用途 | 高频命令 |
|---|---|---|
| 基础 | 导航/快照/操作 | `open` `page` `click` `fill` `keys` `wait` `eval` `shot` `scroll` |
| tab | 多标签 | `tab list` `tab find` `tab close` |
| net | 网络抓包 | `net start` `net list` `net detail` `net initiator` |
| har | 会话录制 | `har start` `har stop` `har save` `har to-replay` |
| hook | 页面注入 | `hook preset xhr` `hook fn` `hook logs` |
| debug | 断点调试 | `debug break-xhr` `debug frames` `debug resume` |
| state | 登录态 | `state save zhihu` `state load zhihu` |
| env | 环境模拟 | `env set` `env reset` `env compare` |
| human | 人机交接 | `handoff` `wait-user` |

## 参数约定

- `--foo-bar v` → 工具参数 `foo_bar`；值能 JSON 解析就解析（`--new-tab true`、
  `--timeout-ms 5000`），否则当字符串。
- `--tab <id>` 指定目标 tab（缺省用当前活动 tab）。
- `--timeout <秒>` 放宽单次调用超时（截图/慢站导航）。
- `--args '<json>'` 整体传参，用于命令别名没覆盖的冷门参数。
- 逃生口：`owb call <ctl工具名> --args '<json>'` 直调任意底层工具；
  `owb cdp` 直发 CDP 命令。

## 输出与错误处理

- 成功：工具的 data 以 JSON 打到 stdout（`--compact` 单行）。
- 失败：stderr 一行 `error CODE: message`，退出码 1；用法错误退出码 2。
- 错误信息是为你写的、可操作的。常见：
  - `NO_EXTENSION` → 扩展没连，先 doctor。
  - `REF_STALE` → 重新 `owb page`。
  - `AMBIGUOUS_TAB` → 多个 tab 匹配，用 `--tab <id>` 指定。
  - `PAUSED` → 页面停在断点上，先 `owb debug resume`。

## 典型任务范式

**抓某站的签名接口**：
```bash
node owb-daemon/src/cli.js net start
node owb-daemon/src/cli.js open <目标页> && node owb-daemon/src/cli.js click @eN   # 触发请求
node owb-daemon/src/cli.js net list --url-pattern "api/sign"
node owb-daemon/src/cli.js net detail --id <请求id>
node owb-daemon/src/cli.js net initiator --id <请求id>                        # 定位发起调用栈
```

**保存并复用登录态**（用户已在浏览器里登录）：
```bash
node owb-daemon/src/cli.js state save zhihu       # cookie + localStorage + IndexedDB
node owb-daemon/src/cli.js state load zhihu        # 换机/换 profile 后恢复
```

**撞验证码/需扫码时交回人类**：
```bash
node owb-daemon/src/cli.js handoff                 # tab 交还用户
node owb-daemon/src/cli.js wait-user               # 用户操作完，你自动接管继续
```

## 边界

- 只驱动用户已授权加载扩展的本机浏览器；不做隐蔽操作、不碰用户没要求的敏感页面。
- 发消息/发帖/提交表单/下单等不可逆动作，先向用户确认再执行。

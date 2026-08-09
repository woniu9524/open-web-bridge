# open-web-bridge

让任何 AI agent 驱动你的**真实浏览器**——你的登录态、你的指纹、你正在看的页面。

三层架构：AI agent → 本地 daemon（Node.js，`127.0.0.1:18086`）→ MV3 Chrome 扩展 → 经 CDP 操作页面。通过 **MCP** 接入，Kimi Code / Claude Code 等工具零适配使用，62 个工具。

## 能干什么

- **语义快照**：`read_page` 给可交互元素打 `@eN` 稳定 ref，`click`/`fill`/`screenshot` 直接引用；`since_last` 增量快照省 token；`article` 模式正文提取为 markdown
- **等待原语**：`wait_for` 等 selector / 文本 / URL / 网络空闲，不再用 evaluate 轮询
- **真实鼠标 + AI 光标**：`mouse_click` 走 CDP Input 域真实鼠标事件（isTrusted），页面内光标贝塞尔动画，用户在旁可见
- **人机交接**：`handoff` / `wait_user`——撞验证码、要扫码登录时把 tab 交还你，你操作完 agent 自动接管继续
- **网络抓包**：请求/响应全量（含头与 body）+ `get_initiator` 调用栈定位
- **任务与工作流**：`daemon_task_begin/end` 归档 + 标签分组；`daemon_workflow_save/run` 把跑通的流程固化成确定性回放
- **站点会话库**：`daemon_state_save/load zhihu` 一键保存/恢复登录态（cookie + localStorage + IndexedDB）
- **页面调试与分析**（按需）：hook 预设（xhr/fetch/crypto）、断点与调用帧读取、脚本改写、函数离线验证、TLS 指纹重放

## 快速开始

前提：**Node.js ≥ 18** + 一个 Chromium 系浏览器（Chrome/Edge）。

```bash
git clone <仓库地址>          # 或下载 zip 解压
cd open-web-bridge/daemon
npm install
node src/server.js            # 启动 daemon，监听 127.0.0.1:18086
```

装扩展（一次性）：

1. 浏览器打开 `chrome://extensions`
2. 右上角打开「开发者模式」
3. 「加载已解压的扩展程序」→ 选择本仓库的 `extension/` 目录
4. 扩展默认连本地 daemon（`ws://127.0.0.1:18086/ws`），无需配对；改地址才需要
   到「扩展程序选项」配置。

接入 AI 工具（以 Kimi Code 的 `config.toml` 为例，其他 MCP 客户端同构）：

```toml
[mcp_servers.owb]
command = "node"
args = ["<仓库绝对路径>/daemon/src/mcp_server.js"]
```

重连 MCP 后即可使用全部 62 个工具。对 agent 说一句「打开知乎搜一下 XXX」就能看到它干活。

## 可选：TLS 指纹重放

`daemon_replay` 需要 curl-impersonate 二进制（仅在验证协议脚本时用）：
从 [lexiforest/curl-impersonate releases](https://github.com/lexiforest/curl-impersonate/releases) 下载对应平台的压缩包，解压到仓库 `bin/` 目录（或设环境变量 `OWB_CURL_BINARY` 指向它）。

## 安全模型（用前请读）

- daemon 只监听 `127.0.0.1`，并校验 WS 握手的 Host/Origin（防 DNS rebinding）
- **本地信任模型，无配对 token**：同机任何进程都可连 daemon。这是刻意的简化——
  连接成本为零；但不要在共享/多用户机器上运行 daemon（同机恶意进程可控制浏览器）
- token 曾作为本机进程防线（v0.7.0–v0.8.0 默认启用 `?token=` 校验），现已移除；
  它防不住同用户恶意进程（能读文件系统），收益小于配置成本
  所以 `work/states/` 明文登录态同样只在你信任本机进程的前提下存放，已 gitignore，分享仓库前注意
- 扩展申请了 `debugger` + `<all_urls>` 权限——这是 CDP 驱动的必要权限，等同于把浏览器控制权交给本机 daemon

## 测试

```bash
cd daemon
node tests/smoke_test.js        # 41 项：协议/守护/编排（自起子进程，无需停 daemon）
node tests/mcp_test.js          # 8 项：MCP 接入面
node tests/verify_replay_test.js # 11 项：离线验证 + 重放
node tests/e2e_browser_test.js  # 68 项：真机端到端（headless Chromium + 真扩展）
node tests/read_page_test.js    # 页面表达式单测（另有 7 个同类文件，共 101 项）
```

## License

MIT

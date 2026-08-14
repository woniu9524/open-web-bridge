# open-web-bridge

让任何 AI agent 驱动你的**真实浏览器**——你的登录态、你的指纹、你正在看的页面。

两种部署形态：

- **本地模式**（默认）：三层架构 AI agent → 本地 daemon（Node.js，`127.0.0.1:43917`）→ MV3 Chrome 扩展 → 经 CDP 操作页面。agent 通过 **`owb` CLI** 接入（Kimi Code / Claude Code / Codex 等任何能跑 shell 的工具零配置直用），配套 skill 教典型流程。
- **中转模式**（可选）：daemon 与扩展都拨出到一个公网中转（Cloudflare Workers + Durable Objects，按 token 配对），让**远程** AI agent 经公网控制你的浏览器，不暴露本机端口。默认关闭，不影响本地模式。

## 能干什么

- **语义快照**：`read_page` 给可交互元素打 `@eN` 稳定 ref，`click`/`fill`/`screenshot` 直接引用；`since_last` 增量快照省 token；`article` 模式正文提取为 markdown
- **等待原语**：`wait_for` 等 selector / 文本 / URL / 网络空闲，不再用 evaluate 轮询
- **真实鼠标 + AI 光标**：`mouse_click` 走 CDP Input 域真实鼠标事件（isTrusted），页面内光标贝塞尔动画，用户在旁可见
- **人机交接**：`handoff` / `wait_user`——撞验证码、要扫码登录时把 tab 交还你，你操作完 agent 自动接管继续
- **交互盲区补齐**：`download`/`upload`（文件下载/上传，上传走页面内 DataTransfer 无需文件系统）、`print_pdf`（导出 PDF）、`list_frames`+`evaluate frame_pattern`（iframe 定向求值）
- **环境模拟**：`emulate`/`emulate_reset` 一次性覆盖设备视口/网络节流/地理/时区/语言/权限/UA，测移动端/慢网/地域场景
- **网络抓包**：请求/响应全量（含头与 body）+ `get_initiator` 调用栈定位
- **会话录制（HAR）**：`record_start/stop` 录全量网络成标准 HAR 1.2（含 timing/WebSocket/主动收 body，支持 url/resource_type 过滤、多 tab 合并）；附 console 归档、storage 变更流、导航截图时间线；`daemon_task_end` 自动收尾 HAR 入档
- **HAR 产物加工**：`daemon_har_to_replay`（→ python/curl/node 重放脚本，动态签名头标占位）、`daemon_har_diff`（两份 HAR 对比漂移）、`daemon_har_assert`（断言校验）
- **任务与工作流**：`daemon_task_begin/end` 归档 + 标签分组；`daemon_workflow_save/run` 把跑通的流程固化成确定性回放
- **站点会话库**：`daemon_state_save/load zhihu` 一键保存/恢复登录态（cookie + localStorage + IndexedDB）
- **页面调试与分析**（按需）：hook 预设（xhr/fetch/crypto）、断点与调用帧读取、脚本改写、函数离线验证、TLS 指纹重放

## 快速开始

前提：**Node.js ≥ 18** + 一个 Chromium 系浏览器（Chrome/Edge）。

```bash
git clone <仓库地址>          # 或下载 zip 解压
cd open-web-bridge/owb-daemon
npm install
```

装扩展（一次性）：

1. 浏览器打开 `chrome://extensions`
2. 右上角打开「开发者模式」
3. 「加载已解压的扩展程序」→ 选择本仓库的 `owb-extension/` 目录
4. 扩展默认连本地 daemon（`ws://127.0.0.1:43917/ws`），无需配对；点工具栏图标
   可看实时连接状态，改地址在弹窗「本地」页填写后保存。

接入 AI 工具——不需要任何客户端配置。agent 直接用 shell 调 `owb` CLI 即可
（daemon 未运行时 CLI 会**自动拉起**，无需先手动 `npm start`）：

```bash
node owb-daemon/src/cli.js                       # 自检：daemon/扩展连接状态
node owb-daemon/src/cli.js open https://www.zhihu.com
node owb-daemon/src/cli.js page                  # 语义快照，得到 @eN ref
node owb-daemon/src/cli.js click @e5             # 引用 ref 操作
node owb-daemon/src/cli.js help                  # 12 个命令组，79 个工具
```

`npm link`（或全局装）后可直接 `owb <命令>`。

装 skill（可选，推荐）——让 agent 一上手就知道怎么用，不靠猜：

```bash
cp -r owb-skills/owb ~/.claude/skills/          # Claude Code：全局装
cp -r owb-skills/owb <你的项目>/.claude/skills/  # 或只在某个项目里装
```

其他 agent 把 `owb-skills/owb/SKILL.md` 内容并入你的规则/系统提示即可（纯 markdown，
无专有格式）。装好后对 agent 说一句「打开知乎搜一下 XXX」就能看到它干活。

## 目录结构

```
open-web-bridge/
├── owb-daemon/     Node 包：owb CLI（agent 接入面）+ 本地 daemon + 测试
├── owb-extension/  MV3 Chrome 扩展（浏览器加载这个目录）
├── owb-relay/      可选：Cloudflare Workers 公网中转（远程控制用）
└── owb-skills/owb/ 交付物：给 AI agent 装的 skill
```

运行时产物（分析归档、登录态、HAR）落在 `work/`，已 gitignore。

## 中转模式（远程控制，可选）

让**远程** AI agent 经公网控制你的浏览器，不用暴露本机端口。默认关闭；开启不影响本地模式。

拓扑：扩展（你的机器）与 daemon（AI agent 机器）都拨出到一个公网中转，按 token 配对，配对后中转做透明双向转发。中转跑在 Cloudflare Workers + Durable Objects 上（空闲休眠，免费额度友好，TLS 内置）。

**1. 部署中转（约 2 分钟，一次性）：**

```bash
cd owb-relay
npm install
npx wrangler login          # 浏览器授权一次
npx wrangler deploy         # 输出 https://owb-relay2.<你的子域>.workers.dev
```

详见 `owb-relay/README.md`。

**2. 扩展端配置：** 点浏览器工具栏的扩展图标 → 切到「中转」页 → 填中转 URL（如 `wss://owb-relay2.xxx.workers.dev`）→ 点「生成」→「保存并重连」。弹窗上方实时显示配对进度（浏览器 → 中转 → daemon 逐环点亮）。

**3. daemon 端配置：** 在 AI agent 机器上设同名环境变量再启动 daemon：

```bash
export OWB_RELAY_URL="wss://owb-relay2.xxx.workers.dev"
export OWB_RELAY_TOKEN="<与扩展端相同的 Token>"
node src/server.js            # 日志会标注「中转模式」
```

两者配对后，`owb daemon-status` 的 `mode` 字段为 `relay`，远程 agent 即可像本地一样驱动浏览器。CLI 接入面不变（仍连本地 `/ctl`）。

## 可选：TLS 指纹重放

`daemon_replay` 需要 curl-impersonate 二进制（仅在验证协议脚本时用）：
从 [lexiforest/curl-impersonate releases](https://github.com/lexiforest/curl-impersonate/releases) 下载对应平台的压缩包，解压到仓库 `bin/` 目录（或设环境变量 `OWB_CURL_BINARY` 指向它）。

## 安全模型（用前请读）

**本地模式（默认）：**

- daemon 只监听 `127.0.0.1`，并校验 WS 握手的 Host/Origin（防 DNS rebinding）
- **本地信任模型，无配对 token**：同机任何进程都可连 daemon。这是刻意的简化——
  连接成本为零；但不要在共享/多用户机器上运行 daemon（同机恶意进程可控制浏览器）
- token 曾作为本机进程防线（v0.7.0–v0.8.0 默认启用 `?token=` 校验），现已移除；
  它防不住同用户恶意进程（能读文件系统），收益小于配置成本
  所以 `work/states/` 明文登录态同样只在你信任本机进程的前提下存放，已 gitignore，分享仓库前注意
- 扩展申请了 `debugger` + `<all_urls>` 权限——这是 CDP 驱动的必要权限，等同于把浏览器控制权交给本机 daemon

**中转模式（可选，v0.9.0+）：**

- **token 是线上唯一秘密**，必须走 wss（Cloudflare 边缘内置 TLS）。连接到某中转房间即证明持有 token（房间按 `sha256(token)` 寻址，哈希泄露也无法逆推构造 URL）。
- **中转是可信 broker**。MVP **无端到端加密**——中转能看到全部明文流量（含登录 cookie/storage）。只用你自己控制的 Cloudflare 账号部署中转，或接受此风险。E2EE（token 派生密钥逐帧加密）为后续硬化项。
- token 在扩展端生成、手动同步到 daemon 环境变量，**勿提交入库**。
- 开启中转模式不改变本地 `/ctl` 的本地信任模型（CLI 仍连本机 daemon）。

## 测试

```bash
cd owb-daemon
node tests/smoke_test.js        # 60 项：协议/守护/编排（自起子进程，无需停 daemon）
node tests/relay_test.js        # 10 项：中转模式集成（mock 中转 + 真 daemon）
node tests/cli_test.js          # 13 项：owb CLI 接入面（命令映射/转发/错误模型）
node tests/verify_replay_test.js # 11 项：离线验证 + 重放
node tests/e2e_browser_test.js  # 68 项：真机端到端（headless Chromium + 真扩展）
node tests/read_page_test.js    # 页面表达式单测（另有 7 个同类文件，共 101 项）

cd ../owb-relay && node test/relay_test.mjs  # 14 项：中转 Durable Object 单元测试
```

## License

MIT

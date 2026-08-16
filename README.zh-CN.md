<div align="center">

<img src="https://raw.githubusercontent.com/woniu9524/open-web-bridge/master/owb-extension/icons/icon128.png" width="96" alt="open-web-bridge" />

<h1>open-web-bridge</h1>

<p>
  <b>让任何 AI agent 驱动你的<i>真实浏览器</i></b><br/>
  你的登录态&nbsp; ·&nbsp; 你的指纹&nbsp; ·&nbsp; 你正在看的那个页面
</p>

<p>
  <a href="https://www.npmjs.com/package/open-web-bridge"><img alt="npm version" src="https://img.shields.io/npm/v/open-web-bridge?style=flat-square&labelColor=1c1c1e&color=8b5cf6&logo=npm&logoColor=white" /></a>
  <a href="https://www.npmjs.com/package/open-web-bridge"><img alt="npm downloads" src="https://img.shields.io/npm/dm/open-web-bridge?style=flat-square&labelColor=1c1c1e&color=8b5cf6&label=downloads" /></a>
  <a href="https://github.com/woniu9524/open-web-bridge/stargazers"><img alt="stars" src="https://img.shields.io/github/stars/woniu9524/open-web-bridge?style=flat-square&labelColor=1c1c1e&color=8b5cf6&logo=github&logoColor=white" /></a>
  <img alt="node" src="https://img.shields.io/node/v/open-web-bridge?style=flat-square&labelColor=1c1c1e&color=8b5cf6&logo=nodedotjs&logoColor=white" />
  <img alt="Chrome MV3" src="https://img.shields.io/badge/Chrome-MV3-8b5cf6?style=flat-square&labelColor=1c1c1e&logo=googlechrome&logoColor=white" />
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/npm/l/open-web-bridge?style=flat-square&labelColor=1c1c1e&color=8b5cf6" /></a>
</p>

<p>
  <a href="https://linux.do?ref=seal-click" target="_blank" rel="noopener noreferrer" title="Best Community · LINUX DO">
    <img src="https://linuxdo-seal.cuishushu.com/seals/seal-best-community.svg" alt="Best Community · LINUX DO" width="150" height="46" />
  </a>
</p>

<p><a href="README.md">English</a> · <b>简体中文</b></p>

</div>

---

## 为什么不用无头浏览器？

agent 自己开一个干净浏览器，能看到的只有公开内容。

驱动**你的**浏览器，它才能读你订阅的那篇文章、看你已经登录的后台、走完那个需要
你身份的流程。这正是本项目存在的理由。

```bash
npm i -g open-web-bridge   # CLI + 扩展文件 + agent skill，一条命令装齐
owb setup                  # 引导你走完唯一需要手动做的那一步
owb                        # 自检 —— 两个 ✓ 就绪
```

然后对 agent 说一句：*「打开 Hacker News，把前三条整理给我。」*

## 工作原理

```text
   AI agent               Claude Code · Codex · Kimi Code · 任何能跑 shell 的工具
      │
      │  owb <命令>        CLI 就是全部接入面 —— 客户端零配置
      ▼
   本地 daemon             Node.js，127.0.0.1:43917
      │
      │  WebSocket
      ▼
   MV3 扩展                装在你平时用的那个浏览器里
      │
      │  Chrome DevTools Protocol
      ▼
   你正开着的标签页          你的 cookie · 你的登录态 · 你的指纹
```

两种部署形态：

- **本地模式**（默认）——就是上面这条链路。任何能跑 shell 的工具零配置直用，
  配套 skill 教 agent 典型流程。
- **中转模式**（可选）——daemon 与扩展都拨出到一个公网中转（Cloudflare Workers +
  Durable Objects，按 token 配对），让**远程** agent 经公网控制你的浏览器，
  不暴露本机任何端口。默认关闭，开启不影响本地模式。[跳到配置 ↓](#中转模式远程控制可选)

## 能干什么

| | 你能得到什么 |
| --- | --- |
| 🔍 **语义快照** | `read_page` 给可交互元素打稳定的 `@eN` 编号，`click`/`fill`/`screenshot` 直接按编号引用；`since_last` 只返回变化的部分（长会话能不能撑住全看这一条）；`article` 模式把正文提取成干净的 markdown |
| ⏳ **等待原语** | `wait_for` 等 selector / 文字 / URL / 网络空闲，不用再拿 `evaluate` 轮询 |
| 🖱️ **真实鼠标 + 可见光标** | `mouse_click` 走 CDP Input 域发真实鼠标事件（`isTrusted`），页面内有贝塞尔光标动画，用户在旁边看得见你在干什么 |
| 🤝 **人机交接** | `handoff` / `wait_user`：撞上验证码或要扫码登录时把标签页交还给你，你弄完 agent 自动接管继续 |
| 📎 **补齐尴尬的交互** | `download`/`upload`（上传走页面内 DataTransfer，不需要文件系统权限）、`print_pdf`、`list_frames` + `evaluate frame_pattern` 定向求值 iframe |
| 🌍 **环境模拟** | `emulate`/`emulate_reset` 一次覆盖设备视口、网络节流、地理位置、时区、语言、权限和 UA |
| 📡 **网络抓包** | 完整的请求与响应（含头和 body），外加 `get_initiator` 定位是哪段代码发出的 |
| 🎞️ **会话录制（HAR）** | `record_start/stop` 录成标准 HAR 1.2（含 timing、WebSocket、主动收取的 body，支持 url/resource_type 过滤与多标签页合并），另附 console 归档、storage 变更流、导航截图时间线；`daemon_task_end` 会自动把 HAR 入档 |
| 🔁 **HAR 加工** | `daemon_har_to_replay`（→ python/curl/node 重放脚本，动态签名头标成占位符）、`daemon_har_diff`（两份录制之间的漂移）、`daemon_har_assert`（断言校验） |
| 🧩 **任务与工作流** | `daemon_task_begin/end` 负责归档和标签分组；`daemon_workflow_save/run` 把跑通的流程固化成确定性回放 |
| 🔐 **站点会话库** | `daemon_state_save/load <名字>` 一键保存/恢复登录态（cookie + localStorage + IndexedDB） |
| 🛠️ **调试与分析** | 按需：hook 预设（xhr/fetch/crypto）、断点与调用帧读取、脚本改写、函数离线验证、TLS 指纹重放 |

## 安装

前提：**Node.js ≥ 18** + 一个 Chromium 系浏览器（Chrome / Edge）。

<details>
<summary><b>让 AI 帮你装</b> —— 把这段整段发给你的 agent</summary>

<br/>

> 帮我安装 open-web-bridge，按顺序做，每步做完告诉我结果：
>
> 1. 运行 `npm i -g open-web-bridge`
> 2. 运行 `owb setup`，把输出里「装浏览器扩展」那一步的具体做法念给我，
>    等我装完再继续
> 3. 运行 `owb`，确认 daemon 和扩展都是 ✓；如果扩展未连接，让我点浏览器工具栏的
>    扩展图标看状态
> 4. 运行 `owb skill install` 装上技能，然后告诉我重开一个会话
>
> 装好后你就能用 `owb` 命令驱动我的浏览器了，`owb help` 看全部命令。

</details>

### 手动装

```bash
npm i -g open-web-bridge     # CLI + 扩展文件 + skill，一条命令装齐
owb setup                    # 引导：扩展安装路径、装 skill、连通性自检
```

`owb setup` 会告诉你扩展怎么装。**这是唯一需要你手动做的一步**——扩展必须装进你
平时用的那个浏览器，因为登录态在那儿，而这正是本项目的意义所在，命令行代劳不了。

装完跑一次 `owb` 自检，两个 ✓ 就绪。然后 `owb skill install` 会把 skill 装给
**检测到的每一个 agent**——Claude Code（`~/.claude/skills/`）、Codex CLI
（`~/.codex/skills/`）、Cursor（`~/.cursor/skills/`）、OpenCode
（`~/.opencode/skills/`）。想自己指定就 `--to claude,codex`，`--project` 只装到
当前项目，`--dir <path>` 装到任意位置。

之后可以用 `owb update check` 对比 npm 上的最新版本，有新版会打印升级步骤——
skill 也教了 agent 在任务收尾时跑一次，所以有更新你不用自己盯。

### 关于 skill

渐进披露结构，`skill install` 会把整个目录装好：

```text
owb/SKILL.md                     主干——每次触发都进上下文
owb/references/commands.md       80 条命令的参数速查
owb/references/recipes.md        按任务查的长配方
owb/references/debugging.md      抓包 / HAR / hook / 断点 / 逆向
owb/references/field-notes.md    实测怪现象，按症状索引
owb/references/relay.md          中转模式配置引导
```

只有 `SKILL.md` 常驻上下文，其余五份由 agent 按需读取。**skill 正文是英文的**
（模型读的东西，统一语言更稳）。其他 agent 直接把这几份 markdown 并进规则或系统
提示即可，没有专有格式。

### 试一下

对 agent 说一句「打开 Hacker News，把前三条整理给我」，就能看到它干活。
或者你自己敲：

```bash
owb open https://example.com
owb page                 # 语义快照：可交互元素带 @eN 编号
owb click @e1            # 直接按编号操作
owb help                 # 全部命令
```

> 从源码跑（开发/尝鲜）：`git clone` 后在仓库根 `npm install`，用
> `node owb-daemon/src/cli.js <命令>` 代替 `owb`，或 `npm link` 之后照常用 `owb`。

## 目录结构

```text
open-web-bridge/          ← npm 包根（package.json 在这里）
├── owb-daemon/src/       owb CLI（agent 接入面）+ 本地 daemon
├── owb-daemon/tests/     测试（不进 npm 包）
├── owb-extension/        MV3 Chrome 扩展
├── owb-relay/            可选：Cloudflare Workers 公网中转（独立部署，不进 npm 包）
└── owb-skills/owb/       给 AI agent 装的 skill（SKILL.md + references/）
```

`npm i -g open-web-bridge` 会把 CLI、扩展文件、skill 一起装到本机——`owb setup`
打印的扩展路径就指向包里那份。运行时产物（任务归档、登录态、HAR）落在 `work/`，
已 gitignore。

## 中转模式（远程控制，可选）

让**远程** agent 经公网控制你的浏览器，不用暴露本机端口。默认关闭。

```text
     你的机器                    Cloudflare                agent 的机器
   ┌──────────────┐             ┌──────────┐             ┌──────────────┐
   │    扩展      │ ─── wss ──▶ │   中转   │ ◀─── wss ─── │    daemon    │
   └──────────────┘             └──────────┘             └──────────────┘
       按 token 配对 · 房间按 sha256(token) 寻址 · Worker 空闲即休眠
```

中转跑在 Cloudflare Workers + Durable Objects 上（空闲休眠，免费额度友好，
TLS 内置），配对后做透明的双向转发。

**1. 部署中转（约 2 分钟，一次性）：**

```bash
cd owb-relay
npm install
npx wrangler login          # 浏览器授权一次
npx wrangler deploy         # 输出 https://owb-relay2.<你的子域>.workers.dev
```

详见 [`owb-relay/README.md`](owb-relay/README.md)。

**2. 扩展端配置：** 点浏览器工具栏的扩展图标 → 切到「中转」页 → 填中转 URL
（如 `wss://owb-relay2.xxx.workers.dev`）→ 点「生成」→「保存并重连」。
弹窗上方实时显示配对进度（浏览器 → 中转 → daemon 逐环点亮）。

**3. daemon 端配置：** 在 agent 那台机器上设同名环境变量，再启动 daemon：

```bash
export OWB_RELAY_URL="wss://owb-relay2.xxx.workers.dev"
export OWB_RELAY_TOKEN="<与扩展端完全相同的 Token>"
owb-daemon                    # 日志会标注「中转模式」
```

配对后 `owb daemon-status` 的 `mode` 变成 `relay`，远程 agent 就能像本地一样驱动
浏览器。CLI 接入面不变（仍连本机 `/ctl`）。

> ⚠️ daemon **只在启动时读环境变量**。如果已经有一个本地模式的 daemon 在跑，
> 必须先停掉它——光设环境变量没有任何作用。

## 可选：TLS 指纹重放

`daemon_replay` 需要 curl-impersonate 二进制（仅在验证协议脚本时用）：
从 [lexiforest/curl-impersonate releases](https://github.com/lexiforest/curl-impersonate/releases)
下载对应平台的压缩包，解压到仓库 `bin/` 目录，或设环境变量 `OWB_CURL_BINARY`
指向它。

## 安全模型（用前请读）

**本地模式（默认）：**

- daemon 只监听 `127.0.0.1`，并校验 WS 握手的 Host/Origin（防 DNS rebinding）
- **本地信任模型，无配对 token**：同机任何进程都可以连 daemon。这是刻意的简化
  ——连接成本为零；但**不要在共享/多用户机器上跑 daemon**，同机的恶意进程可以
  控制浏览器
- token 曾作为本机进程的防线（v0.7.0–v0.8.0 默认启用 `?token=` 校验），现已移除：
  它防不住以同一用户身份运行的恶意进程（那种进程本来就能读文件系统），
  收益小于配置成本
- 同理，`work/states/` 下的明文登录态，只在你信任本机进程的前提下才是安全的。
  该目录已 gitignore，分享仓库前请再确认一次
- 扩展申请了 `debugger` + `<all_urls>` 权限——这是 CDP 驱动所必需的，
  等同于把浏览器控制权交给本机 daemon

扩展能访问什么、数据去了哪、每一项权限为什么需要，见 **[PRIVACY.md](PRIVACY.md)**。
短版本：不向开发者发送任何数据，也不存在我们运营的服务器。

**中转模式（可选）：**

- **token 是线上唯一的秘密**，必须走 `wss`（Cloudflare 边缘内置 TLS）。
  能连上某个中转房间即证明持有 token（房间按 `sha256(token)` 寻址，
  哈希泄露也无法逆推出可用的 URL）
- **中转是可信 broker。** 目前**没有端到端加密**——中转能看到全部明文流量，
  包括登录 cookie 和 storage。请只用你自己控制的 Cloudflare 账号部署，
  否则就是接受这个风险。E2EE（token 派生密钥逐帧加密）是后续硬化项
- token 在扩展端生成，手动同步到 daemon 的环境变量，**不要提交入库**
- 开启中转模式不改变本地 `/ctl` 的信任模型（CLI 仍然连本机 daemon）

## 测试

```bash
npm test              # 全部无头套件 + 扩展侧 node --check 语法闸门
npm run test:browser  # 真机端到端（需要 Chrome）
npm run test:replay   # TLS 重放（需要 curl-impersonate 二进制）
npm run test:relay    # 中转 Durable Object 单元测试
```

`npm test` 按目录约定收集 `owb-daemon/tests/*_test.js`——新增套件不用改任何
脚本就会被跑到——且**不会首败即停**，跑完全部再按套件汇总。只有需要外部环境
（真浏览器、要下载的二进制）的两个套件被排除在外。

<details>
<summary>单独跑</summary>

<br/>

```bash
node owb-daemon/tests/smoke_test.js          # 协议 / 守护 / 编排（自起子进程，无需停 daemon）
node owb-daemon/tests/cli_test.js            # owb CLI 接入面：命令映射、转发、错误模型
node owb-daemon/tests/slug_test.js           # 文件名 slug，含非 ASCII 名字
node owb-daemon/tests/docs_examples_test.js  # skill 里每条 `owb ...` 示例都是真实存在的命令
node owb-daemon/tests/docs_run_test.js       # 无副作用的 skill 示例真的能跑通
node owb-daemon/tests/harexport_test.js      # HAR → 重放 / 对比 / 断言
node owb-daemon/tests/relay_test.js          # 中转模式集成（mock 中转 + 真 daemon）
node owb-daemon/tests/verify_replay_test.js  # 离线验证 + 重放
node owb-daemon/tests/e2e_browser_test.js    # 真机端到端（headless Chromium + 真扩展）
node owb-daemon/tests/read_page_test.js      # 页面表达式单测（另有若干同类文件）
node owb-daemon/tests/rolling_log_test.js    # 日志轮转 / 保留窗口与审计脱敏
```

</details>

最后那两个文档示例测试是因为一次具体的失败才加的：**测试跑的命令和文档教用户写的
命令是两套东西**，于是文档里的示例可以坏掉，而所有测试照样全绿。

## License

MIT © [woniu9524](https://github.com/woniu9524)

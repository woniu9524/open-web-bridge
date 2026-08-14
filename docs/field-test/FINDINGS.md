# 实地测试发现清单

对 117 个真实站点跑核心链路（open → page → article）+ 深度交互实测，记录暴露出的
问题。每条含：现象、复现、根因、影响面、状态。

数据：`raw.jsonl`（广度扫描原始记录）、`sweep.mjs`（扫描脚本）、`sites.json`（站点清单）。

---

## 已修复

### BUG-70 · `innerText` 空导致 43% 的 ref 变成哑元素 🔴 高影响

**现象**：界面新闻首页快照里 260 个 ref 中 112 个（43%）形如
`@e17 link "" href=https://www.jiemian.com/lists/65.html`——没有任何文字，
AI 只能靠 URL 猜这个链接是干嘛的。网易新闻 130/323、虎嗅 92/257、豆瓣电影 93/242
都是同一现象。

**复现**：
```bash
owb open https://www.jiemian.com/ --new-tab true
owb page      # 数 @eN xxx "" 的行
```

**根因**：`nameOf` 取名链的倒数第二环是 `el.value || el.innerText`。而 **`innerText`
遵循 CSS 可见性**——元素处在 `visibility:hidden` 的容器里（悬停下拉菜单、折叠导航
极其常见）时返回空串。但这类元素**仍有非零布局盒**，所以通过了快照的尺寸过滤进了
结果，只是没了名字。页面里实测：同一个 `<a>` 的 `innerText === ""` 而
`textContent === "科技"`。

**修复**：`nameOf` 增加两级回退——
1. `el.textContent`（不依赖渲染，能拿到隐藏容器内的文字）
2. 后代 `img[alt] / img[title] / [aria-label]`（纯图片链接如
   `<a><img alt="界面新闻logo"></a>` 自身无文字，alt 挂在子元素上）

**影响面**：所有带悬停菜单/折叠导航的站点，以及图片链接为主的站点（新闻、电商、
门户重灾区）。修复前 AI 对这些元素只能盲点。

---

### BUG-72 · 后台标签页快照静默全空 🔴 高影响

**现象**：中国政府网快照 `count:0 / lines:""`，而同一页 article 模式能提到 2231 字。
页面 DOM 里有 198 个 `<a href>`。

**复现**（关键是让目标 tab 处于未绘制状态——并发开别的 tab 即可触发）：
```bash
owb open https://www.gov.cn/ --new-tab true
owb open https://example.com/ --new-tab true   # 把上一个挤到后台
owb page --tab <gov.cn 的 tabId>               # → count:0
```

**根因**：Chrome **不给后台/未绘制的 tab 做布局**，页内所有元素
`getBoundingClientRect()` 全返回 0。快照用「宽高 > 0」判可见性，于是 198 个链接
被全部过滤掉。实测：前台化前可见链接 0/198，`Page.bringToFront` 后 97/198，
快照立刻恢复正常。

**为什么危险**：失败是**静默**的——AI 拿到一份合法的空快照（`count:0`，无任何
错误），会得出"这页没内容"的错误结论，然后走上完全错误的路径。

**修复**：
1. 快照表达式新增 `skippedNoRect` / `candidates` 统计
2. `read_page` 检测到「有候选元素但全被零尺寸过滤」时，自动 `Page.bringToFront`
   + 重试一次
3. 无论恢复成功与否，结果里带 `renderNote` 说清发生了什么

**关联**：`send_keys` 早有同类修复（BUG-58：后台 tab 收不到 Input 事件），
说明「tab 未前台化」是这套架构的系统性陷阱面，值得在 skill 里专门提示。

### BUG-76 · `owb shot` 把 473KB base64 直接打进 AI 上下文 🔴 高影响

**现象**：`owb shot` 返回体含完整 base64 图像数据（实测 473,796 字符）。AI 在 shell
里跑一次截图，**一条命令就吃掉整个上下文窗口**，而 base64 对它毫无可读价值。
`print_pdf` 同理，且通常更大。

**根因**：截图/PDF 工具只返回 base64，无落盘选项；CLI 又原样透传 stdout。
CLI 的读者是 AI 的上下文窗口，不是磁盘——这层没做区分。

**修复**（CLI 层）：
1. `screenshot` / `print_pdf` 自动落盘，stdout 只回 `{savedTo, bytes, format}`；
   `--out <路径>` 可指定文件名
2. 通用护栏：任何工具返回超过 60KB 时截断超长字符串字段，附 `_clipped` 说明
   与 `_hint`（怎么拿全量）

**验证**：修复后输出
`{"tabId":...,"format":"png","savedTo":"/tmp/owb-shot-....png","bytes":355347}`

### BUG-77 · 改扩展代码必须手点 chrome://extensions 重载 🟡 开发体验

扩展管理页禁止被 debugger 附着，AI 无法代劳，每次改 `background.js` 都要人工介入，
在长周期迭代里是硬阻塞。

**修复**：新增 `reload_extension` 工具（扩展调用 `chrome.runtime.reload()` 自重启，
先回包再重载）+ CLI `owb reload-ext`。**注意**：该能力本身需要先手工重载一次才生效。

### BUG-73 · 抓包列表混入「无身份」孤儿记录 🟠 中影响

**现象**：USGS 地震地图上 `owb net list` 返回 45 条请求，每条只有
`{status:200, finished:true, failed:false}`——**没有 URL、没有 method、
连 requestId 都没有**。AI 既认不出这是哪个请求，也无法拿它去 `net detail`。
整份抓包结果等于废掉。

**触发条件**：在**页面已加载后**才 `net start`，随后 `reload`。此时 CDP 只送来
响应侧事件（`responseReceived`/`loadingFinished`），而携带 url/method 的
`requestWillBeSent` 发生在抓包启动之前，记录便成了孤儿。
BBC 同样操作下 1/60，USGS 下 45/45——比例取决于站点请求模式。

**修复**：`network_list` 默认剔除 `!url && !requestId` 的记录，改为单独计数
`orphanRecordsHidden`（`include_orphans:true` 可看）。这个计数本身是有用信号：
数量大 = 抓包启动晚了，该在导航**之前** `net start`。

**沉淀进 skill**：抓包的正确顺序是 `net start` → `open`，不是 `open` → `net start`
→ `reload`。

### BUG-74 · 抓包丢弃 CDP 已给的耗时与体积 🟠 中影响

`Network.loadingFinished` 事件本就带 `encodedDataLength` 和结束时刻、
`responseReceived` 带完整 `timing` 分解，但缓冲只记了 `{finished:true}` 与
status/headers/mimeType，其余全丢。后果：**「哪个请求最慢/最重」——性能排查的
第一个问题——在列表里无从回答**，只能对每条单独 `network_detail`（几百条时不可行）。

**修复**：缓冲补记 `finishedAt`/`encodedDataLength`/`timing`/`fromCache`/
`remoteAddress`；`network_list` 输出 `durationMs`/`size`；新增
`sort_by=duration|size`。`sort_by` 与 `newest` 语义冲突（排序后从尾部取会拿到
最快的几条），排序优先且 `order` 字段如实反映。

### BUG-75 · 导航到不可达域名返回「假成功」🔴 高影响

**现象**：
```bash
owb open https://this-domain-truly-does-not-exist.invalid/
# → {"url":"...","title":"...","loadCompleted":true}   退出码 0
```
DNS 必然失败的域名，却报告加载完成。AI 据此继续操作，面对空快照无从判断
「是页面没内容」还是「压根没打开」。

**根因**：代码里**已有**错误页检测（查 `location.href` 是否 `chrome-error://`），
但 `navigate` 全流程从未调用 `ensureAttached`——未附着时 `Runtime.evaluate` 必抛，
异常又被 `catch (e) {}` 吞掉，检测形同虚设。
实测确认：`tab.url` 保留请求 URL，只有**页内** `location.href` 才是
`chrome-error://chromewebdata/`，所以这条页内探测不可省。

**修复**：探测前先 `ensureAttached`；同时读取 Chrome 错误页的 `#main-frame-error`
与 `.error-code`，把 `ERR_NAME_NOT_RESOLVED` / `ERR_CONNECTION_CLOSED` 等
**错误码带回**——AI 才能区分「域名写错了」和「网络不通」这两种完全不同的处置。

**教训**：`catch (e) {}` 静默吞异常，会让一条本来正确的检测逻辑长期处于失效状态
而无人察觉。

---

## 待修复

### ISSUE-01 · SPA 首屏未渲染完就返回 `loadCompleted` 🟠 中影响

**现象**：澎湃新闻 `nav=2307ms` 就返回 `loadCompleted:true`，但快照只有 6 个 ref
（152 字节），正文提取 0 字。同类：牛客 10 refs、力扣 17 refs。

**根因推测**：`open` 的完成判定基于文档 load 事件，SPA 的内容在其后由 JS 渲染。

**候选解法**：
- `open` 增加"内容就绪"启发式（等待 DOM 节点数稳定 / 首个非骨架元素出现）
- 或在 skill 里明确：SPA 站点 `open` 后必须 `owb wait --network-idle` 再 `page`

**待验证**：先量化——对这几个站测 `open` 后加 `wait --network-idle` 能否救回。

### ISSUE-02 · 中国政府网快照 0 个元素 🟠 中影响

**现象**：`snap=0refs/0B`，但 article 模式提取到 2231 字。页面明显有大量链接。

**待查**：是否 iframe 承载？是否 shadow DOM？是否被 `SEL` 漏掉的元素类型？

### ISSUE-03 · 默认 20000 字符上限对中文内容站偏小 🟡 低影响

**现象**：V2EX / 36氪 / 虎嗅 / 豆瓣 / 起点 / 新浪 / 网易 / 界面 / 观察者网等
9+ 站点首屏快照即触顶截断。

**说明**：截断**有**明确信号（`truncated:true` + `omittedNodes`），不算 bug。
但中文站信息密度高，默认值让 AI 频繁只看到半页。

**候选解法**：skill 里明确教 `--max-chars` / `--max-nodes` 调整；或按语言/密度
动态调整默认值。

### ISSUE-04 · 部分站点导航耗时 15–30s 🟡 待归因

开源中国 30.2s、新浪 27.8s、网易新闻 19.5s、腾讯新闻 18.2s、淘宝 19.2s、
掘金 16.3s、V2EX 15.4s、CSDN 15.2s。

**待查**：是站点本身慢/被墙，还是 `open` 的完成条件过于严格（等所有子资源）？
若是后者，`wait_until: domcontentloaded` 应能大幅改善——需要对照实测。

### ISSUE-05 · 导航途中 `page` 偶发 FORBIDDEN（即便显式 `--tab`）🟡 偶发

**现象**：npm OTP 页跳转过程中调 `owb page --tab <id>`，报
`FORBIDDEN: Cannot access a chrome-extension:// URL of different extension`，
而该 tab 明明是 https 页面。重试即恢复。

**推测**：前一次失败调用（活动 tab 恰为扩展页）在 debugger attach 状态留下残留，
后续显式 tabId 的调用被旧状态污染。

**关联**：可能与 e2e 测试里既有的 11 项 hook/断点失败同源（都涉及 attach 时序）。

---

## 观察（非 bug，但值得沉淀进 skill）

- **正文提取失败的站是可预测的**：论坛/列表页（V2EX、牛客）本就没有"正文"，
  article 模式返回 0 字是正确行为，不是 bug——skill 应说明"列表页用 snapshot，
  文章页用 article"。
- **链接始终带 `href`**：即使名字为空，AI 也能从 URL 判断去向。这是个被低估的
  可用性保障，skill 应提醒 AI 善用。
- **快照对 shadow DOM 有覆盖**（`collect` 会递归 open shadow root），Web Component
  站点不会整片消失。

### BUG-78 · 服务端 4xx/5xx 错误页被当作正常加载 🟠 中影响

**现象**：澎湃新闻直接返回 **403 Forbidden**（正文只有 `403 Forbidden Zen/4.3`
共 21 字符），`owb open` 仍报 `loadCompleted:true`。AI 拿到一份几乎空的快照，
会误判成「这页没内容」并继续往下走，而真相是**被站点拒了**。

**与 BUG-75 的区别**：那个是网络层失败（`chrome-error://`），这个是**加载成功的
错误页**——服务器正常回了 403 和一段正文，浏览器层面没有任何异常。

**修复**：复用已有的页内探测（零额外开销），用「标题像 HTTP 状态码 + 正文极短」
识别，输出 `httpErrorHint` **只提示不拦截**（有些站点的 404 页做得很丰富，
硬判会误伤）。

### BUG-79 · 其他扩展注入的悬浮 UI 混进快照 🟠 中影响

**现象**：澎湃 403 页的快照里 6 个「页面元素」全是某翻译扩展注入的悬浮工具栏
（`图片翻译` / `语音翻译` / `快捷设置` / `关闭(Esc)`），页面自身元素为 0。
AI 会把它们当成页面功能去点击。

**根因**：快照收集 `document.querySelectorAll(SEL)`，不区分元素来自页面还是
来自用户装的其他扩展。用户装的扩展越多，噪声越大。

**修复**：按注入宿主容器识别并整棵剔除（Plasmo/CRXJS 等主流扩展框架都用带前缀的
自定义元素挂载），剔除数记入 `extensionUiHidden`。


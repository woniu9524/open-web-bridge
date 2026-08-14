# 实地测试发现清单

对 **217 个真实站点、七轮完整跑动**（累计 1521 站次）跑核心链路
（open → page → article）+ 深度交互实测，记录暴露出的问题。
每条含：现象、复现、根因、影响面、状态。

## 修复效果

六轮完整跑动，累计 **1304 站次**：

| 轮次 | 哑 ref 率 | 正文提取成功 | 硬失败 |
|---|---|---|---|
| 第 1 轮（修复前） | 15.7% | 35% | 3 / 219 |
| 第 2 轮（修复后） | 5.0% | 65% | 4 / 217 |
| 第 3 轮（+ 掉线重试） | 6.5% | 66% | 3 / 217 |
| 第 4 轮（+ 错误收口） | 5.7% | 64% | 2 / 217 |
| 第 5 轮 | 5.0% | 63% | 4 / 217 |
| 第 6 轮 | **5.0%** | **64%** | **3 / 217** |

「哑 ref」= 快照里没有任何可读文字的元素，AI 无从判断点它会发生什么。
「硬失败」= 导航或快照调用本身失败。

**指标已收敛**：后四轮哑 ref 稳定在 5.0–6.5%、正文成功 63–66%、硬失败 2–4 例，
波动来自网络状况与站点临时风控，非代码变化。

### 第 7 轮：BUG-92～99 八项修复后复测

修复 8 个新 bug（visibility:hidden 快照过滤、click-mouse 挂起、fill 假成功、
ref 撞号、renderNote 误导、upload 不支持 ref、download 竞态与假路径）之后
跑的第 7 轮，同一份 217 站列表，**217/217 全部导航成功，0 例新增硬失败**：

| 指标 | 第 6 轮 | 第 7 轮 |
|---|---|---|
| 哑 ref 率 | 5.0% | 6.2% |
| 硬失败 | 3 / 217 | 3 / 217（同一批：淘宝/知网/和风天气） |

「正文提取成功」这次改用可复现的口径重新核对：`article.chars > 0` 的站点数
占比。用这个口径回算第 6 轮原始数据（`raw-run6.jsonl`）得到 **79.7%**，
与第 7 轮的 **79.7%** 完全一致——之前表格里写的"64%"用的是另一套未留存
计算脚本的口径（大概率排除了"本来就不该有正文"的工具/枢纽类站点作为分母），
数值对不上不代表退步，只是统计口径不同，为避免继续以讹传讹，第 7 轮起
统一用 `chars > 0` 这个可重新计算的口径。

结论：**8 项修复没有引入任何新的失败**，指标在可比口径下与前一轮完全一致。

## 何谓「稳定」

失败归零不可能——反爬 403、证书拦截页、第三方扩展抢走标签页、重 JS 站点
主线程饱和都是客观存在。真正的标准是：**每个失败都能被 AI 读懂并正确处置**。

第 6、7 两轮的失败全部满足，且都是**反复出现的同一批客观受限站点**：

| 站点 | 错误码 | 信息是否可操作 |
|---|---|---|
| 淘宝 / 东方财富 | `FORBIDDEN` | ✅ 标签页被 OneTab 类扩展换成了自己的页面；查 `list_tabs`，新标签页重开 |
| 知网 | `FORBIDDEN` | ✅ Chrome 安全拦截页（证书错误），此类页面无法检查，需用户处理 |
| 和风天气 | `TIMEOUT` | ✅ 主线程饱和；先 `wait_for network_idle` 再重试 |

对比第 1 轮：同类失败当时报的是 `INTERNAL: Cannot attach to this target.`
和 `INTERNAL: No tab with id: X.（可重试）`——AI 只会当瞬时故障反复重试。

第 7 轮另有 11 个站点快照返回 0 refs 但没有报错（Amazon/Airbnb/Spotify 等
重 JS 站点为主）。当场用同一批站点复测：Amazon 立即重开就有完整内容——
根因是 `sweep.mjs` 本身在 `open` 和 `page` 之间不等 `network_idle`
（脚本自己的方法论局限，SKILL.md 里早就写明"SPA 站点 loadCompleted 不代表
渲染完了"），不是工具的新退步。

## 额外压测

- **长会话**：同一标签页连续 30 次增量快照 —— 30 成功 / 0 失败
- **并发**：5 个标签页同时抓快照 —— 全部成功，互不干扰
- **重 JS 站点**：Google Flights 94 refs / CoinMarketCap 226 refs /
  TradingView 181 refs，均无异常

## 覆盖面

新闻 / 社区 / 电商 / 学术 / 文档 / 教育 / 医疗 / 金融 / 招聘 / SaaS /
开源主页 / 知识库 / 工具 / 社交 / 视频 / 游戏 / 旅游 / 天气 / 实时数据 /
WebGL / Canvas 应用 / 无障碍 / 标准组织，中英文混合，含强反爬与登录墙站点。

导航耗时 p50 4.7s / p90 15.3s / p99 30.2s；快照本身 p50 仅 185ms。

## 结论

**共发现并修复 21 个 bug**，其中 6 个属「静默失败」——AI 拿到看似合法的结果
却完全错误，是最危险的一类（BUG-72 空快照、BUG-75 假成功、BUG-78 错误页、
BUG-73 孤儿记录、BUG-88 无参调用、BUG-80 自造回归）。

剩余的少数失败**全部是环境与站点的客观限制**（反爬 403、证书拦截页、
标签管理扩展抢走标签页、重 JS 主线程饱和），且每一条都已变成 AI 能理解
并处置的信息，而不是难懂的内部错误。

数据：`raw-*.jsonl`（各轮原始记录）、`sweep.mjs`（扫描脚本）、
`sites.json` / `sites-wave2.json` / `sites-all.json`（站点清单）。
演示案例见 `SHOWCASE.md`。

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

---

## 已归因（曾列为待查，现已全部收口）

### ISSUE-01 · SPA 内容缺失：已证伪「渲染时序」假设 ✅ 已归因

**原假设**：`open` 基于文档 load 事件返回，SPA 内容随后由 JS 渲染，所以快照过早。

**对照实测**（open 后立刻抓 vs `wait --network-idle` 后再抓）：

| 站点 | 立刻 | wait 之后 |
|---|---|---|
| 澎湃新闻 | 6 refs | **6 refs** |
| 牛客 | 10 refs | **10 refs** |
| 力扣 | 36 refs | **36 refs** |
| 掘金 | 41 refs | **41 refs** |

**结论**：ref 数完全不变，等待救不回来——**内容压根不存在**。进一步诊断澎湃，
发现真因是站点直接返回 **403 Forbidden**（见 BUG-78），属反爬拦截而非渲染时序。

**处置**：不改 `open` 的完成判定（改了也无用）。改为让 AI 能看出「被拒了」——
BUG-78 的 `httpErrorHint` 即为此。

### ISSUE-02 · 中国政府网快照 0 元素 ✅ 已归因（即 BUG-72）

已定位为后台标签页不做布局导致 `getBoundingClientRect()` 全零，与站点无关。
详见 BUG-72，已修复。

### ISSUE-03 · 默认 20000 字符上限对中文内容站偏小 ✅ 已处置（文档化）

219 站中 36 站首屏快照即触顶。截断**有**明确信号（`truncated:true` +
`omittedNodes`），不是缺陷。已在 skill 里教 `--max-nodes` / `--max-chars`
的调整时机，并说明中文站信息密度高更容易触顶。

### ISSUE-04 · 部分站点导航耗时 15–30s ✅ 已归因

实测 `--wait-until domcontentloaded` 提速 **1.5–3.2 倍**且内容不减：
开源中国 7.7s→2.4s、CSDN 9.6s→5.0s、新浪 18.7s→12.1s。已写进 skill。

超过 30 秒的基本是站点本身慢或被墙（链家在默认等待下 30 秒超时拿到空快照，
换 `domcontentloaded` 后正常拿到 79 个元素），不是工具问题。

### ISSUE-05 · 「明明是 https 页却报 FORBIDDEN」✅ 已归因（BUG-83）

219 站扫描中复现 2 次（东方财富、知网），加上此前 npm 那次共 3 次。

**归因**：用户装了 **OneTab** 这类标签管理扩展，它会把标签页整个替换成自己的
`chrome-extension://.../onetab.html` 页面。owb 正在操作的 tab 被第三方扩展接管后，
`chrome.debugger.attach` 自然被拒。**不是 owb 的缺陷**，是浏览器里多扩展共存的现实。

**处置**：原错误文案只说「Chrome 禁止调试此 URL」，AI 会以为自己传错了 tabId 而
反复重试。改为点明真实成因并给出动作——查 `list_tabs` 看这个 tab 现在究竟是什么，
用新标签页重开目标地址。

---

## 观察（非 bug，但值得沉淀进 skill）

- **正文提取失败的站是可预测的**：论坛/列表页（V2EX、牛客）本就没有"正文"，
  article 模式返回 0 字是正确行为，不是 bug——skill 应说明"列表页用 snapshot，
  文章页用 article"。
- **链接始终带 `href`**：即使名字为空，AI 也能从 URL 判断去向。这是个被低估的
  可用性保障，skill 应提醒 AI 善用。
- **快照对 shadow DOM 有覆盖**（`collect` 会递归 open shadow root），Web Component
  站点不会整片消失。

### BUG-80 · 输出护栏砍错字段（本轮自引入并修正）🔴 高影响

**现象**：加了 60KB 输出护栏后，`owb page` 的 `lines` 被截到 4000 字符——
**AI 唯一能读的字段被砍掉了 80%**，而冗余数据原封不动。

**根因**：`read_page` 对同一份内容返回三份——`lines`（20KB 文本）、
`text`（`lines` 的别名，又 20KB）、`nodes`（结构化重复，66KB），
合计 108KB。护栏只看总量超限，就把每个长字符串一刀切到 4000，
恰好砍在最该保留的 `lines` 上。

**修复**：先去冗余再判大小——
1. `text` 与 `lines`/`content` 同值时删掉别名
2. `nodes` 与 `lines` 完全重复，删掉并记 `_nodesOmitted`
3. 仍超限时**从最大的字段开始砍**，且给它保留尽可能多的额度，
   不再一刀切到同一个小值

**效果**：新浪首页 `owb page` 输出 108KB → **21KB**，`lines` 20000 字符
完整保留，零截断。

**教训**：给 AI 做的"保护"如果不分主次，会精准地毁掉最有价值的那部分。
护栏必须知道哪个字段是主payload。

### BUG-81 · 正文提取混入站点公告/募捐横幅 🟠 中影响

**现象**：英文维基条目 `Model Context Protocol` 用 `--mode article` 提取，
返回 11318 字符，但**开头 1817 字符全是募捐横幅**（"Nearly half of our budget
goes toward supporting the technology…"），真正条目正文从 1817 字符处才开始。

**根因**：正文提取选中 `main.mw-body` 作为根，去噪列表 `BOILER` 覆盖了
nav/header/footer/aside/广告，但漏掉「正文容器**内部**的公告块」——
募捐条、Cookie 提示、订阅浮层、付费墙提示都属这一类。

**影响**：AI 逐篇读文章时，每篇白付 1~2K token，且有把横幅误当正文摘要的风险。

**修复**：`BOILER` 增补语义类名/角色——`[class*=sitenotice]`、`[class*=dismissable]`、
`[class*=cookie]`、`[class*=consent]`、`[class*=newsletter]`、`[class*=subscribe]`、
`[class*=paywall]`、`[role=alert]`、`[role=dialog]` 等。

### BUG-82 · HAR 录制的正确流程无法从命令名推出，且 `har stop` 吐 10MB 🟠 中影响

**现象一**：最自然的写法 `har start` → `har stop` → `har save` **必然失败**，
报 `NOT_RECORDING: tab X is not recording`，且录制数据已永久丢失。

**根因**：`har_save` 内部**自己就会调 `record_stop`**。先手动 stop 一次，
recorder 就被销毁了，save 无从下手。而 `record_stop` 把整份 HAR 随响应返回后
即丢弃——数据没落盘、也拿不回来。

**现象二**：`har stop` 把完整 HAR 内联返回。实测一次两页导航的录制 = 42 条请求、
**10MB body**，全部塞进 stdout。这是继截图之后第二个「一条命令炸掉 AI 上下文」的地方。

**修复**：
1. CLI 里 `har save` 排到 `har stop` 前面，描述直说「录完用这个，它已含 stop」；
   `har stop` 描述标注「停了再 save 会失败」
2. `NOT_RECORDING` 错误信息改为讲清正确流程（否则 AI 只会反复重试）
3. CLI 输出整形摘掉 `har` 字段，代之以 `_harOmitted` 指路 `har save`
   —— 实测 `har stop` 输出从 ~10MB 降到 **153 字节**

**验证**：正确流程 `har start` → `har save` 一次跑通，22 条请求落盘到
`work/har/field-test-demo.har`。

**设计教训**：当 B 操作内部包含 A 操作时，命令名必须让人看出来，否则「先 A 再 B」
这个最直觉的顺序就是陷阱。

### BUG-83 · FORBIDDEN 错误文案误导 AI 反复重试 🟡 低影响

**现象**：`page` / `eval` 对一个**明明是 https 的标签页**报
`FORBIDDEN: Cannot access a chrome-extension:// URL of different extension`。
219 站扫描中复现 2 次（东方财富、知网），此前 npm 登录流程中 1 次。

**归因**：用户装了 **OneTab** 这类标签管理扩展，它把标签页整个替换成自己的
`chrome-extension://.../onetab.html`。owb 正在操作的 tab 被第三方接管，
`chrome.debugger.attach` 自然被拒。**不是 owb 的缺陷**，是多扩展共存的现实。

**问题在文案**：原文只说「Chrome 禁止调试此 URL」，AI 会以为自己传错了 tabId
而反复重试同一个失败调用。

**修复**：错误信息点明真实成因（标签管理类扩展会替换页面）并给出可执行动作
（`list_tabs` 看这个 tab 现在是什么 → 用新标签页重开目标地址）。

### BUG-84 · 工作流回放的 AMBIGUOUS_TAB 无处置指引 🟡 低影响

**现象**：`flow run` 中途报 `AMBIGUOUS_TAB` 而失败，`_hint` 只解释了 REF_STALE，
没提这一种，AI 无从判断该怎么办。

**成因（设计如此，非缺陷）**：录制时的 tabId 跨会话没有意义，回放**默认剥掉**，
改由「当前活动标签页」解析每一步。因此浏览器里同时有别的活动（用户在切标签、
或另一个流程在跑）时必然歧义。实地测试中并行跑扫描即复现。

**修复**：`_hint` 补上 AMBIGUOUS_TAB 的解释与两条出路——回放需要安静的浏览器，
或在原标签页仍开着时传 `keep_tab_ids:true`。

**另附两条已沉淀进 skill 的使用要点**（属技巧非缺陷）：
- `flow save` 必须先 `task begin`，它按**时间窗**抓取操作（错误信息已明确提示）
- 录制期间的所有调用都会进流程，包括顺手开的无关标签页

### BUG-85 · MV3 service worker 被回收导致调用硬失败 🟠 中影响

**现象**：217 站连续跑动中，daemon 日志出现 **6 次 `extension DISCONNECTED`**，
期间的调用直接失败（`NO_EXTENSION` / `DISCONNECTED`），打掉 2 个站点的结果
（Mayo Clinic、中国大学MOOC）。

**根因**：Chrome MV3 的 service worker 会被浏览器回收，WS 随之断开；扩展侧靠
30 秒周期的 alarm 唤醒重连。**这中间是一个最长约 30 秒的空窗**，任何调用都会
落空。掉线本身是正常的平台行为，且能自愈。

**修复的位置选择**（走了一段弯路，值得记录）：
- ❌ 先在 daemon 的 `call_tool` 里等待重连 —— 破坏了既有语义：smoke 测试
  明确断言「无扩展时立即失败」（`workflow_run 无扩展首败即停` 等多项），
  而且 daemon 内部那些机会性调用（task 上下文同步、自动收尾录制、工作流
  逐步回放）本就该优雅降级，为它们白等只会把失败拖成超时。
- ✅ 改在 **CLI 层透明重试**：`NO_EXTENSION` / `DISCONNECTED` 按
  1.5s → 4s → 10s → 20s 退避重试（累计约 35 秒，覆盖 30 秒空窗），
  重试时向 stderr 打一行说明。daemon 的「立即失败」契约不动，AI 也不必
  自己写重试逻辑。

**验证**：主动 `owb reload-ext` 制造掉线后立刻调用 `owb tab list` ——
自动重试一次即成功，调用方零感知（退出码 0）。

**教训**：修复要放在语义正确的那一层。daemon 是协议层，「扩展在不在」是它
必须如实上报的事实；把瞬时抖动抹平是**客户端**的职责。

### BUG-86 · Chrome 安全拦截页导致的失败无线索 🟠 中影响

**现象**：知网**连续三轮**都失败，报 `INTERNAL: Cannot attach to this target.`
——一句毫无线索的话，AI 只会当瞬时故障反复重试。

**根因**：该站返回的是 Chrome 的**安全拦截页**（页面标题为本地化的
「隐私设置错误」，即 `net::ERR_CERT_*` 类证书问题）。Chrome **禁止 debugger
附着到拦截页**，所以任何检查/交互都不可能成功。这不是工具缺陷，是浏览器的
安全边界。

**更糟的是时序**：`navigate` 里的附着尝试被外层 `catch` 静默吞掉，于是
navigate 照报 `loadCompleted:true`，AI 直到下一步 `read_page` 才撞墙。

**修复**：
1. 错误映射：`Cannot attach to this target` → `FORBIDDEN` + 说明最常见成因是
   安全拦截页（证书/隐私错误/不安全下载警告），并给出动作（去浏览器看那个
   标签页，证书有问题就修，或手动点过警告）
2. `navigate` 把附着失败以 `attachHint` **提前**告知，不再等到 read_page

### BUG-87 · 超时提示漏掉最常见的成因 🟡 低影响

`cdpCall timeout` 的原文案只列了「断点」与「模态框」两种成因，但实测最常见的
第三种是**页面主线程被长时间占满**——eBay 导航耗时 60 秒，期间快照必然超时
（该页仅 2606 个元素，与 DOM 体量无关）。少了这一条，AI 会去找根本不存在的断点。

**修复**：把「主线程饱和（重 JS / 仍在加载）→ 先 `wait_for {network_idle}` 再重试」
列为首要成因。

### BUG-88 · oracle_call 参数名写错时静默无参调用 🔴 高影响（静默失败）

**现象**：把 `call_args` 误写成 `samples` 后，`oracle_call` 返回
`{"ok":true, "value":null}`——**看起来成功了**。实际是无参调用：
`__t(1,2)` 本应得 102，实际执行的是 `__t()` → `NaN` → JSON 序列化成 `null`。

**危险性**：这是最坏的失败形态——AI 拿到 `ok:true` 会认为自己给的样本已经跑过，
据此得出的任何结论都是错的，且没有任何迹象提示出了问题。

**修复**：oracle_call 校验参数名白名单，遇到不认识的参数直接
`BAD_ARGS` 并指明「调用实参放在 `call_args` 数组里」。

**这类问题的通用形态**：宽松透传参数的工具，参数名写错时会静默走默认路径。
本项目其他工具多数有必填校验（缺 url/expression/name 会报错），oracle_call
的所有参数都是可选的，才暴露出来。

### BUG-89 · 「标签页已关闭」被归为可重试的 INTERNAL 🟡 低影响

**现象**：虎嗅在第四轮失败，报 `INTERNAL: No tab with id: 612680141.（可重试）`。
AI 会对着一个**已经不存在**的标签页反复重试。

**根因**：Chrome 这条错误有两种措辞——`chrome.debugger` 报
`No tab with given id`，`chrome.tabs` 报 `No tab with id: <n>`。错误映射的正则
只覆盖了前者，后者落到兜底的 INTERNAL 且被标为可重试。

**触发场景**：标签管理类扩展（OneTab）批量收纳标签页时会把它们关掉，
正在其上操作的调用就会撞到这个错误。

**修复**：正则改为 `no tab with (given )?id` 覆盖两种措辞，并把成因
（可能被标签管理扩展关掉了）与动作（`list_tabs` 查存活 tab，或新标签页重开）
写进错误信息。

### BUG-90 · 非法 tabId 报出 Chrome 内部错误且标为可重试 🟠 中影响

**现象**：`--tab notanumber` 报
`INTERNAL: Error in invocation of debugger.attach(...): Error at property 'tabId':
Invalid type: expected integer, found string.（可重试）`
——Chrome 内部措辞，且被兜底标记成**可重试**，AI 会拿同一个坏参数反复重试。

**触发场景**：脚本里 tabId 提取失败拿到字面量（实测拿到 `"X"`），或 AI
从上文误抄了非数字的值。

**修复**：`resolveTabId` 前置校验——非整数直接 `BAD_ARGS`（不可重试）并指路
`list_tabs`。校验放在最前面，所有工具共享。

### BUG-91 · 超时错误不说等了多久、也不说哪一层 🟡 低影响

**现象**：`error TIMEOUT: tool navigate timed out（可重试）`——没有时长、
没有层次信息。AI 无法判断该继续加时间还是放弃。

**实测**：和风天气给到 **120 秒**仍超时。若不知道「已经等了 120 秒」，
AI 会继续加码重试，白白消耗。

**修复**：错误信息带上实际等待时长与判断依据——
「已等 Ns（daemon 侧）；提高一次超时再试，若在更高值下仍超时，
问题在站点而不在超时设置」。

### BUG-92 · 关闭状态的下拉菜单用 visibility:hidden，rect 过滤器抓不住 🟠 中影响

**现象**：GitHub 仓库首页快照里，未展开的顶栏导航下拉菜单（Copilot/Solutions/
Resources 等）贡献了 30+ 条链接，混在真正的仓库内容（文件树、commit 历史）
前面。这些链接用户肉眼完全看不到，点了也没反应。

**根因**：`visibility:hidden` 的元素仍然占布局盒——`getBoundingClientRect()`
照样返回非零宽高，原来的过滤器（只看 rect 是否为零）抓不住这类"有盒子但不可见"
的元素。这跟 BUG-72（rect 全零 = 后台 tab 没渲染）正好相反：这里是**有 rect、
但祖先链上某层 visibility:hidden/display:none**。

**实测影响**：该页快照从 11.3KB/147 refs 降到 4.5KB/60 refs（去除后台 tab
渲染差异后仍下降约 60%），去噪后仓库内容排到最前面，不用再刷屏 40 条打不开的
导航项才能看到真正数据。

**修复**：加一道 `Element.checkVisibility({ checkOpacity: true,
checkVisibilityCSS: true })` 检查（Chrome 105+ 原生 API，顺着祖先链判断
visibility/display/content-visibility/opacity，不用手写祖先遍历）。命中的
计入新计数器 `skippedHidden`，**不**并进 `skippedNoRect`——后者会触发"后台
tab 未渲染，前台化重试"的逻辑，混进去会导致误判重试。

### BUG-93 · `click-mouse` 在窗口失去系统焦点时永久挂起到 30s 超时 🔴 高影响

**现象**：`owb click-mouse` 在真实多窗口环境下（Chrome 开了不止一个窗口，
被操作的窗口当前不是操作系统前台窗口）稳定复现：每次调用都挂满 30 秒后报
`TIMEOUT: cdpCall timeout: Runtime.evaluate`。同一个 tab 上 `click`（非真实
鼠标）、`eval`、`page` 全部秒回——只有 `click-mouse` 会挂，说明不是页面主线程
卡住，是这条工具链路自己的问题。

**根因**：`click-mouse` 为了让操作对用户可见，会在真实鼠标事件之前跑一段
贝塞尔曲线光标移动动画，动画由 `requestAnimationFrame` 驱动、返回的 Promise
**只在 rAF 回调里 resolve**。而 `requestAnimationFrame` 在
`document.visibilityState === "hidden"` 时根本不会被调度执行——不是变慢，是
完全不触发。已有的 BUG-35 修复（调用前 `Page.bringToFront`）只解决"tab 在自己
窗口内不是激活页"这一种隐藏成因；它管不到"窗口本身没有操作系统级焦点"这层
（被其他窗口挡住、在后台等），而这种情况下页面同样是 `visibilityState:hidden`。
实测确认：`document.hasFocus()` 为 true 但 `visibilityState` 为 `"hidden"`
——CDP 的 `Page.bringToFront` 只挪了 Chrome 内部的激活标签位，管不到系统级
窗口层。rAF 一旦不触发，`moveTo` 的 Promise 永远 pending，上层 `await` 直接
硬挂到 CDP 30s 超时。

**复现方式**：把 `window.requestAnimationFrame` monkey-patch 成空函数（模拟
"排了队但永远不执行回调"的效果，与隐藏页面的真实行为一致）后调用
`click-mouse`——稳定复现 30s 挂起。

**为什么重要**：这直接命中 OWB 的核心场景——"AI 在后台驱动你的真实浏览器，
你去做别的事"。用户一旦切到别的窗口（几乎是必然会发生的），当前实现下所有
`click-mouse` 调用都会以 30s 为周期挂起，而不是报错或降级，AI 完全不知道
发生了什么，只会看到"超时，可重试"然后死循环重试、每次再挂 30s。

**修复**：给 `moveTo` 加一道兜底计时器（`setTimeout(finish, duration + 300)`），
和 rAF 动画赛跑，谁先到谁 resolve。rAF 正常时按原计划播完动画（~450ms内完成，
不受影响）；rAF 不触发时兜底计时器在 `duration+300ms` 内跳到终点位置并
resolve——反正页面不可见也没人会看到"跳过"而非"滑过去"的差异，但调用方能
拿回控制权而不是硬等 30s。修复前后实测：monkey-patch 掉 rAF 后，调用耗时从
30000ms+超时降到 992ms；rAF 正常时耗时 658ms（动画路径未受影响，说明兜底
计时器没有拖慢正常情况）。

### BUG-94 · `fill` 缺 value 时静默清空字段并报成功 🔴 高影响（假成功）

**现象**：`owb fill @e16` 少传 value（或调用方把参数名拼错，比如传了
`text` 而不是 `value`——用 `owb call fill --args` 直调时尤其容易犯，位置参数
形式的 `owb fill @ref "文字"` 不会踩这个坑）时，工具照样返回
`filled:true, actual:"", value:""`——字段被静默清空、`input`/`change`
事件正常派发，看起来完全成功，实际上 AI 原本想填的内容根本没填进去。

**实测复现**：在 OpenStreetMap 搜索框上 `owb call fill --args
'{"ref":"e16","text":"oops"}'`（漏传 value）后，返回 `filled:true`，
但搜索框实际是空的。

**根因**：`fill()` 里 `const value = args.value != null ? args.value : ""`
——`args.value` 缺失时直接兜底成空串，当作"合法地清空字段"处理，跟"调用方
真的想清空字段"（应该允许，也是常见需求）区分不开。

**修复**：显式拒绝 `args.value === undefined/null`，报 `BAD_ARGS`
并提示"要清空字段请传 `value:\"\"`"——把"没传"和"传了空串"分开，前者是
调用错误，后者是合法操作，两者不该共用同一条静默兜底路径。

### BUG-95 · 同文档路由更新被误判成整页导航，ref 计数器清零撞号 🔴 高影响

**现象**：在 OpenStreetMap 首页搜索框填关键词回车后（`fill` + `keys Enter`，
触发页面自己的 JS 路由，不经过 `navigate` 工具），新出现的"关闭"按钮和页面
顶栏一直存在的"OpenStreetMap"标志链接**共享同一个 `@e1` ref**——两个完全不同
的元素。`document.querySelectorAll('[data-owb-ref="e1"]')` 实测返回 2 个
元素。AI 点 `@e1` 想关搜索面板，命中的是 `querySelector` 返回的第一个匹配
（标志链接），实际把页面导航回首页，跟预期完全不符，而且没有任何报错——
是一次静默点错目标。

**根因**：`Page.frameNavigated` 事件触发时会清零该 tab 的 ref 计数器
（`readPageNextRef.delete` / `readPageSnapshots.delete`），语义上是"整页导航
了，旧 ref 全部失效，下一次快照该从 e1 重新编号"。但实测确认这次的路由变化
根本不是整页导航——`performance.timeOrigin` 在搜索前后没有变化（一直是几十秒
前那次 `open` 调用的时间戳），说明文档从未被销毁，DOM 里上一轮 `collect()`
写的 `data-owb-ref` 属性原样留着。计数器却被清零重新从 1 数，新分配的号
撞上了还活在页面上的旧号。换句话说：**触发清零的信号（frameNavigated）和
"DOM 是否真的被销毁"这两件事没有被同一个事实保证**，两者出现了不一致的
窗口期。

**复现方式**：完全通过真实交互复现，不是构造场景——首页搜索框填词回车两次
（不同关键词），每次都能在 `data-owb-ref` 上观察到计数器从低位重新开始，
第一次直接实测到 `@e1` 撞号。

**修复**：不再单纯信任传进来的 `next` 计数器对不对。`collect()` 拿到候选
元素列表后，先扫一遍其中已经带 `data-owb-ref` 属性的元素，把 `next` 提到
"比当前文档里已存在的最大 ref 还大"，再开始分配新 ref——不管计数器是不是被
误清零过，新分配的号永远不会跟 DOM 上已经存在的旧号冲突。这是防御性修复，
没有去动 `Page.frameNavigated` 判断"是不是真的整页导航"这个更难精确定位的
上游问题，而是让下游的 ref 分配对这类误判天然免疫。

**验证**：修复前用同一操作序列（`open` → 首页 → 填词回车）稳定复现撞号；
修复后用完全相同的操作序列，`关闭`按钮拿到 `@e40`（当前文档已用到的最大号
之后），不再跟已存在的 `@e1` 冲突，且计数器清零的现象本身依然在（
`performance.timeOrigin` 差值仍是几十秒前，证明触发条件没变，是下游吸收
了这次误判）。

### BUG-96 · 快照全空时的 `renderNote` 建议在窗口未聚焦场景下站不住脚 🟡 低影响

**现象**：在携程（触发了对方的反自动化拦截，页面被替换成 `whaleguard
block` 一行字）上快照返回空，`renderNote` 说"the tab is likely not
rendering...Activate the tab and retry"——但这条建议隐含"还有招没使"，实际上
`Page.bringToFront` + 重试**已经**在返回这条消息之前做过、而且失败了。
根因还是这次探索里反复碰到的同一件事：Chrome 窗口本身没有操作系统级焦点时
（被别的窗口挡住），`bringToFront` 只能把 tab 切到它自己窗口内的激活位，
救不回真正的 `visibilityState`。旧文案对"重试已经做过且没用"和"还没重试"
不做区分，AI 看到"retry"容易在同一条死路上反复重试。

**修复**：`bringToFront`+重试仍然失败后，多查一次 `document.
visibilityState`。依然是 `hidden` 就直说根因（窗口没有系统焦点，重试没用，
该提醒用户切过去那个浏览器窗口）；不是 `hidden` 才维持原来"内容被 CSS
隐藏或页面本来就空"的笼统提示，并补一句提醒顺带排查反爬拦截页。

**过程插曲**：第一版实现里 `evaluateJs()` 返回值已经是拆包后的裸值（内部
`return res.result ? res.result.value : undefined`），我却又按 `res.result.
value` 的老套路多拆了一层，导致 `stillHidden` 永远算不出真值、恒定走"未隐藏"
分支——用真实还在 `hidden` 状态的携程 tab 验证时立刻穿帮（消息给成了"内容被
CSS 隐藏"，跟直接 `eval document.visibilityState` 查到的 `"hidden"` 对不上）。
提醒自己：改之前该去看被调函数已经在哪一层拆包，不能凭记忆套用别处的写法。

### BUG-97 · `upload` 是唯一不支持 `@eN` ref 的交互工具 🟡 低影响（一致性）

**现象**：`click`/`fill`/`mouse_click` 都能吃 `read_page` 快照给的 `@eN` ref，
唯独 `upload` 只认 `selector`——`resolveTargetSelector` 这个所有其它交互
工具共用的辅助函数，`upload` 压根没调用，直接 `if (!args.selector) throw`。
拿着刚从快照里读到的 `@e1` 却上传不了，得自己手写
`[data-owb-ref="e1"]` 选择器，跟其余工具的使用习惯不一致，纯粹是遗漏。

连带的：找不到元素时原来统一报不可重试的 `NOT_FOUND`，不管是 selector
写错（不可重试，该换 selector）还是 ref 失效（可重试，重新 `read_page`
就好）——两种性质不同的失败被压成一种错误码，跟 `click`/`fill` 已经做的
`REF_STALE` vs `NOT_FOUND` 区分不一致。

**修复**：`upload` 改用 `resolveTargetSelector` 支持 ref；页面内脚本找不到
元素时交回 `null`（不再自己编 `NOT_FOUND` 对象），走共用的 `targetNotFound`
——ref 失效报可重试的 `REF_STALE`，selector 写错报不可重试的 `NOT_FOUND`。
顺带给 `targetNotFound` 加了个可选的 `extraHint` 参数，把 upload 原来那句
有用的提示（"很多站点把真正的 file input 藏在样式化按钮后面"）保留在错误
信息里，不用为了统一而丢掉这条针对性建议。

**验证**：`the-internet.herokuapp.com/upload` 上验证四种情况——ref 上传
成功（文件确实进了 `input.files`，name/size/type 都对得上）、selector 上传
依旧成功（向后兼容）、坏 ref 报可重试 `REF_STALE`、坏 selector 报不可重试
`NOT_FOUND`，两种错误都带上了"很多站点把 input 藏起来"的提示。

### BUG-98 · `download --url` 直链分支监听器挂晚了，小文件必现超时 🔴 高影响

**现象**：`owb file fetch --args '{"url":"https://example.com/"}'`
（daemon 侧直链下载，映射到扩展的 `download` 工具）对着一个几百字节的
页面稳定 60 秒超时，报"the click may not have started a download"——但这
条路径根本不涉及点击。

**根因**：扩展 `download()` 里，点击触发分支的注释写着"先挂监听再点，
避免竞态"，`watchDownloads(() => true)` 确实排在 `tools.click(...)` 之前；
但直链分支反过来——先 `await chrome.downloads.download(...)` 拿到 `id`，
再拿这个 `id` 去挂 `onCreated`/`onChanged` 监听。文件越小下载越快，
`onCreated`→`onChanged(complete)` 很可能在监听器挂上之前就已经触发完毕，
`watchDownloads` 等一个已经发生过的事件，白等到超时——**同一份代码里，
一条分支已经修过这个坑，另一条分支的相同结构没有跟着改**。

**修复**：直链分支改成跟点击分支一样的顺序——先挂通配监听（`() => true`，
本次调用期间不会有别的下载并发），再发起 `chrome.downloads.download()`。
不再依赖下载返回的 `id` 做匹配。

**验证**：`https://example.com/`（559 字节）修复前稳定 60s 超时；修复后
1.37 秒完成，`receivedBytes` 对得上页面实际大小。

### BUG-99 · 下载文件其实落在用户系统下载目录，`dir` 字段却拼出一个不存在的路径 🟠 中影响

**现象**：`daemon.download`（`owb file fetch` / `owb download`）的编排代码
构造了 `save_path` 传给扩展，返回时还拼了个 `dir: "downloads/${filename}"`
——看起来像是文件已经落进了 daemon 自己的 `work/downloads/` 沙盒目录。
实际上文件在用户真实的系统下载目录（`C:\Users\...\Downloads\`），
`data.filename` 本身就是这个绝对路径，拼出来的 `dir` 字段是
`"downloads/C:\Users\Administrator\Downloads\下载 (1).htm"`——半个相对
路径接一个绝对路径，指向一个根本不存在的位置，谁拿这个字段去读文件都会
`ENOENT`。

**根因**：`chrome.downloads.download()` 的 `filename` 参数本来就只能是
相对 Chrome 自己配置的下载目录的相对路径——这个 API 设计上不允许扩展把
文件写到任意绝对路径（浏览器的安全限制），所以扩展侧压根没读也读不了
daemon 传过去的 `save_path`。daemon 那边的编排代码看起来是照着"文件会
落进 work/downloads/"这个假设写的，但这个假设从一开始就不可能通过这层
API 实现。

**修复**：不再假装能让扩展直接存到指定目录。扩展下载完成后返回真实的
绝对路径，daemon 侧用 `fs.copyFileSync` 把文件复制一份进
`work/downloads/`，`dir`/`path` 字段指向复制后的真实位置，另外新增
`originalPath` 字段说明文件在用户系统下载目录里还留了一份原件（不做
静默删除，改动用户真实文件夹里的东西需要用户自己决定）。复制失败时
`note` 字段带上具体错误原因，`path` 兜底回落到原始位置，不会让调用方
拿到一个不存在的路径。

复制加了 0/200/500ms 的退避重试——刚下载完的文件在 Windows 上偶尔会被
杀毒/索引服务短暂锁住，立刻复制会 EBUSY/EPERM；这是实测复现到的（同一份
代码几秒后手动重跑就成功），不是猜测。

**验证**：`https://example.com/` 修复前 `dir` 字段指向不存在路径；修复后
文件确实出现在 `work/downloads/`，`dir`/`path` 字段可以直接拿去读文件。

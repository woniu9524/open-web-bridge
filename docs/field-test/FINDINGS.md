# 实地测试发现清单

对 **217 个真实站点、五轮完整跑动**（累计约 1100 站次）跑核心链路
（open → page → article）+ 深度交互实测，记录暴露出的问题。
每条含：现象、复现、根因、影响面、状态。

## 修复效果

| 轮次 | 哑 ref 率 | 正文提取成功 | 硬失败 |
|---|---|---|---|
| 第 1 轮（修复前） | 15.7% | 35% | 3 / 219 |
| 第 2 轮（修复后） | 5.0% | 65% | 4 / 217 |
| 第 3 轮（+ 掉线重试） | 6.5% | 66% | 3 / 217 |
| 第 4 轮（+ 错误收口） | **5.7%** | **64%** | **2 / 217** |

「哑 ref」= 快照里没有任何可读文字的元素，AI 无从判断点它会发生什么。
「硬失败」= 导航或快照调用本身失败。

## 覆盖面

新闻 / 社区 / 电商 / 学术 / 文档 / 教育 / 医疗 / 金融 / 招聘 / SaaS /
开源主页 / 知识库 / 工具 / 社交 / 视频 / 游戏 / 旅游 / 天气 / 实时数据 /
WebGL / Canvas 应用 / 无障碍 / 标准组织，中英文混合，含强反爬与登录墙站点。

导航耗时 p50 4.7s / p90 15.3s / p99 30.2s；快照本身 p50 仅 185ms。

## 结论

**共发现并修复 18 个 bug**，其中 6 个属「静默失败」——AI 拿到看似合法的结果
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

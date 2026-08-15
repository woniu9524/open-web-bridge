---
name: owb
description: 用 owb 命令驱动用户自己的浏览器——带着用户已登录的账号去读页面、查资料、填表、走流程、调试网站、审计适配、抓包逆向。当任务需要「打开某个网页看看」「把这几页内容整理一下」「帮我在某站上操作」「我的网站前端出问题了」「这个请求的签名是怎么算的」，或任何需要用户登录态/真实浏览器环境才能完成的事情时使用。
---

# owb — 驱动用户的真实浏览器

`owb` 操作的是**用户此刻正在用的那个浏览器**：他登录过的账号、他的设置、他开着的标签页。
所以你能看到只有登录后才存在的内容，也能替他完成需要身份的操作。

同样因此：**你的每一步都作用在真人的账号上**，而且**他很可能正在旁边同时用
这个浏览器**。读可以随便读，改要先问；开页面用新标签页，别顶掉他正看的东西。

## 这份文档怎么用

**赶时间只看三节**：「开始之前」→「一次任务的完整形状」→「核心循环」。

本文件只讲主干。**四份附文件在同一个目录里，按需读**：

| 文件               | 什么时候读它                                        |
| ---------------- | --------------------------------------------- |
| `reference.md`   | 查某条命令有哪些参数、默认值、上限、返回字段——**写复杂调用前先查，别猜参数名**   |
| `debugging.md`   | 调试/逆向：抓包、HAR 加工与断言、hook、断点、脚本搜索改写、离线验签、TLS 重放 |
| `relay.md`       | 用户问「能不能远程控制我的浏览器」「中转模式怎么配」，或 `daemon-status` 显示 relay 模式 |
| `field-notes.md` | 实测踩过的长尾怪现象详情（下面「现实环境」一节是症状索引，对上号了再去读细节）      |

**命令没写到的怎么办**：本文件覆盖不了全部 82 条命令。
`owb help` 看全部 16 组，`owb help <组名>` 看组内详情，
`owb call <底层工具名> --args '<json>'` 直调任意底层工具。**别猜命令名，去查。**

## 开始之前

```bash
owb          # 自检
```

- `✓ daemon` + `✓ 扩展已连接` → 开工
- `✗ 扩展未连接` → **停下来告诉用户**点浏览器工具栏的扩展图标看状态。别硬调工具，
  只会一直 `NO_EXTENSION`
- 命令不存在 → `npm i -g open-web-bridge` 然后 `owb setup`
- 第一条命令跑出 `[owb] daemon 未运行，自动拉起…`（stderr）**不是错误**，
  是 CLI 在拉 daemon，等它连上就好，别报给用户当故障

自检里的「模式」有两种：**本地模式**（默认，daemon 和浏览器在同一台机器）
和**中转模式**（浏览器在用户机器上、agent 在别处，经公网中转配对）。
本地模式什么都不用配。中转模式的配置引导、能力差异、故障排查全在 `relay.md`。

## 一次任务的完整形状

**这是最该先看的一节。** 单条命令怎么用都写在后面，但如果不知道一次工作从哪
开始、到哪结束，你会把几十个互不相关的标签页堆进同一个地方，收尾只能一个个
关——实测就这么堆到过 25 个。

多步任务（**只要不止"打开一个页面看一眼"，就算多步**）标准四步：

```bash
owb task begin "竞品定价调研"      # ① 开任务：建一个 task: 竞品定价调研 分组
owb open <url> --new-tab true      # ② 干活：新开的 tab 自动进这个组
owb page / click / fill / wait     #    …正常操作
owb task end                       # ③ 收档：停录制、归档、返回产出了哪些 tab
owb tab close-group                # ④ 清场：一条命令关掉本任务全部 tab
```

每一步都有**它自己的理由**，不是仪式：

| 步骤                | 不做会怎样                                  |
| ----------------- | -------------------------------------- |
| `task begin`      | 所有 tab 涌进公共暂存组，跟别的任务、跟用户自己的 tab 混作一团   |
| `--new-tab true`  | **直接顶掉用户当前正在看的页面**——这是真人的浏览器，不是你的      |
| `task end`        | 录制不停、任务不归档；`flow save` 也会报 `NEED_TASK` |
| `tab close-group` | 标签页无限堆积，越堆越难分清哪个是谁的                    |

⚠️ **`task end` 不关标签页。** 它归档、清任务上下文、**报告**产出了哪些
tabId，但页面还开着（有时你就是想留着看结果）。真要清场必须再来一条
`tab close-group`。"end"这个词的字面预期和实际行为不一致，别想当然。

`tab close-group` 一次关掉「OWB 临时」+ 全部「task:」组；**交接组默认保留**
（那是用户正在操作的现场），要一起关得显式传 `--args '{"include_handoff":true}'`。
反过来只想关暂存组、留着 task 组，传 `--args '{"include_tasks":false}'`。

一次性查看不用起任务，直接 `owb open <url> --new-tab true` 就行，tab 会落进
「OWB 临时」暂存组。返回里的 `taskHint` 会告诉你那个组里现在堆了几个——**数字
在涨就是该 `task begin` 的信号**。

⚠️ **扩展被回收会丢任务上下文。** MV3 的 service worker 空闲会被 Chrome 回收
（见后文"扩展偶尔会掉线"），重启后 `currentTask` 没了：**组还在，但之后新建的
tab 不再进那个组**，会散落回「OWB 临时」。症状是任务做到一半 tab 开始跑到别处
去。发现了就重新 `task begin`（同名会复用同一个组）。

⚠️ **丢了上下文之后 `task end` 会报 `NO_TASK`，于是这个任务永远不会被归档。**
`owb reload-ext`、daemon 重启（比如你刚改完代码）都会造成这个结果。
**但 `tab close-group` 仍然有效**——它按组名找，跟任务上下文无关，清场不受影响。
真需要归档就在收尾前确认 `owb daemon-status` 的 `current_task` 还在；
不在就重新 `task begin` 同名任务再 `task end`（会新建一个任务目录，
旧目录里的东西还在原地）。

## 你的 tab 和用户的 tab

OWB 开在**用户此刻正在用的浏览器**里，所以浏览器里永远同时存在两批标签页。
分不清这两批，轻则清场时误关用户的东西，重则**读错页面还不自知**。

| 分组           | 颜色  | 谁的        | 何时产生                           |
| ------------ | --- | --------- | ------------------------------ |
| `task: <标题>` | 青   | 你的        | `task begin` 之后 `--new-tab` 建的 |
| `OWB 临时`     | 蓝   | 你的        | 没有活动任务时 `--new-tab` 建的（暂存区）    |
| `✋ OWB 等你操作` | 橙   | **交给用户的** | `owb handoff` 之后（验证码/登录现场）     |
| 无分组          | —   | **用户自己的** | 用户自己开的，你绝不该动                   |

**护栏**：`owb tab close` 只允许关前三类；关无分组的 tab 会直接报
`FORBIDDEN` 拒绝。这是保护不是故障——撞到了先想"我是不是拿错 tabId 了"，
而不是急着加 `--force true`。

⚠️ **别假设一个 tab 还是你上次留下的那个。** 用户随时可能在同一个 tab 里
改开别的网址，其他自动化也可能复用它。实测踩过：隔了一段时间后拿旧 tabId 去
`eval` 读棋局，返回的却是完全无关的搜索结果页——**命令全部"成功"，数据全是错
的**，这种错比报错难发现得多。隔轮之后要复用 tabId，先 `owb tab list`（或
`owb tab find --url-pattern "<正则>"` 直接按 URL 找）确认它现在是什么，
或者干脆开新的。

## 核心循环：看 → 指 → 动

`owb page` 把页面变成带编号的清单，每个可交互元素一个 `@eN`，你直接用编号操作，
不用猜 CSS 选择器。

```bash
owb open https://example.com --new-tab true   # ← 别省，见下
owb page                      # @e1 @e2 … 各自带角色、文字、href
owb fill @e3 "关键词"
owb keys --keys Enter         # 提交：按真实回车键
owb wait --text "结果"         # 等就绪，别 sleep
owb click @e5
```

⚠️ **`--new-tab true` 不是可选的。** 省掉它 = 在用户当前那个标签页里直接
跳转，把他正看的东西顶掉。只有你**明确就是要操作当前这个页面**时才省。

💡 **`--active false` 让新 tab 在后台打开**，不抢用户的屏幕焦点。批量开一堆
页面来读时尤其该带上——用户不会被你的任务一次次弹走。
（注意：后台 tab 有时会触发"没在渲染"的空快照，见后文 `renderNote`。）

🚨 **但后台 tab 不是活动 tab，后面每一条命令都必须显式 `--tab`。**
`page`/`eval`/`wait`/`click` 不给 `--tab` 时用的是**活动**标签页——你刚开的
后台 tab 不是它，**用户自己正在看的那一页才是**。省掉 `--tab` 的后果不是报错，
是**静默读了用户的私人页面还当成任务数据**（实测：`open` 返回 tabId A，
紧接着的 `page` 读到的是用户的内部后台系统）。

```bash
owb open <url> --new-tab true --active false   # → 返回里记下 tabId
owb page --tab <刚返回的 tabId>                 # ← 每一条都要带
```

`open` 的返回里有 `backgroundTabHint`，会把该传的 tabId 直接写给你。
有活动任务时忘了带 `--tab` 会报 `AMBIGUOUS_TAB`（护栏，见「出错怎么办」），
但**没有活动任务时没有这层保护**——这也是多步任务一定要先 `task begin` 的理由之一。

### 键盘：`owb keys`

`fill` 只把值塞进输入框，**不产生按键事件**。要提交搜索、关弹窗、走快捷键，
都得用 `keys`：

```bash
owb keys --keys Enter                 # 提交
owb keys --keys Escape                # 关弹窗/退出全屏
owb keys --keys "ArrowDown ArrowDown Enter"   # 空格分隔，依次按
owb keys --keys "Ctrl+a"              # 修饰键组合（Ctrl|Alt|Shift|Meta）
owb keys --text "逐字输入的文本"        # 走 insertText，不产生逐键事件
```

⚠️ **`--text` 和 `--keys` 二选一，同时给会报 `BAD_ARGS`**。要先打字再回车就
调两次。命名键：Enter Tab Escape Backspace Delete Home End PageUp PageDown
方向键 Space F1–F12，单个字符和组合键也认。

### 快照怎么读

一行长这样，信息量比你以为的大：

```
@e17 link "科技" href=https://www.jiemian.com/lists/65.html
@e2  textbox "Search models, datasets, users..."
@e48 textbox "< 1B 6B 12B" type=range
@e86 textbox "Filter by name" type=search
      checkbox "订阅周报" checked
      link "下一页" href=... disabled
```

- **链接永远带 `href`**——即使名字为空，也能从 URL 判断去向。这是被低估的兜底。
- 输入框带 `type=`（range/search/date/email…），`required`、`checked`、`disabled`
  都会标出来，`<select>` 会列出可选 `values=[...]`。
- `iframes` 字段列出页面里的 iframe，`shadowRoots` 说明有多少内容来自 Web Component
  （快照会自动进 open shadow root，不会整片丢失）。
- iframe 里的元素要操作，先 `owb frames` 看清单，再 `owb eval --frame-pattern <正则>`
  定向求值；`contextId:null` 的是跨域框架，求值不了。

### ⚠️ 编号会过期

页面跳转或重渲染后旧编号失效，报 `REF_STALE`。**重新 `owb page` 拿新编号**，
别拿旧的重试。

### ⚠️ 快照被截断了要看出来

约四分之一的站点首屏快照就会触顶（默认 20000 字符 / 400 节点）。截断时返回里有
`truncated: true` 和 `omittedNodes`。**看到就调大或缩小范围**：

```bash
owb page --max-nodes 1200 --max-chars 60000    # 要全量（max-nodes 硬顶 2000）
owb page --mode article                         # 只要正文（文章页）
```

中文内容站信息密度高，尤其容易触顶。

## 省 token 的关键：增量快照

操作之后**不要重读整页**。用 `--since-last` 只拿变化：

```bash
owb fill @e86 "qwen3"
owb wait --network-idle true
owb page --since-last true
# → added=54 changed=6 removed=62 unchanged=340
```

只有 54 条新内容进你的上下文，而不是 400 个元素。长会话能不能撑住，全看这一条。

## 三种读法，别用错

| 模式                        | 用在哪                      | 返回字段      |
| ------------------------- | ------------------------ | --------- |
| `owb page`（默认 snapshot）   | 要**操作**页面：找按钮、填表、点链接     | `lines`   |
| `owb page --mode article` | **文章页**读正文，输出干净 markdown | `content` |
| `owb page --mode text`    | 列表页、结构不规则的页面，要全部文字       | `text`    |

💡 **三种模式都有 `text` 字段**——它是各模式主字段的别名。写脚本处理输出时
优先读 `text`，就不用按模式切字段名。

⚠️ **列表页/论坛首页用 article 会返回 0 字**——它们本来就没有"正文"，这是正确行为
不是故障（V2EX、牛客、各种榜单页都是如此）。空返回时看 `reason` 字段，会说明原因。

💡 **正文读成 0 字、但 `hiddenContentNote` 说 DOM 里有上万字 → 改用 `--mode text`。**
这是滚动淡入动画没触发（Chrome 窗口没有系统焦点时会无限期卡住）。
`text` 模式会**自动回退到 `textContent`** 把正文捞出来，并在返回里标
`textSource: "textContent-fallback"`。实测 claude.com 博客：`article` 模式 3 字、
`text` 模式回退后 25161 字。

⚠️ 回退来的文本是 **DOM 顺序不是视觉顺序**，且会带上整块导航菜单、隐藏的
无障碍文本。当正文用没问题，**别拿它判断页面布局**。用户在场时，让他把窗口切到
前台再读一次更干净。

## 等待与超时

```bash
owb wait --selector ".result-item"      # 等元素出现
owb wait --text "共 128 条"             # 等文字出现
owb wait --url-pattern "search"         # 等跳转
owb wait --network-idle true            # 等请求停下（SPA 首选）
```

四选一，**同时给两个会报 `BAD_ARGS`**。别用 sleep。

⚠️ **SPA 站点 `open` 返回 `loadCompleted:true` 不代表内容渲染完了**。实测澎湃新闻
2.3 秒就返回完成，但快照只有 6 个元素。遇到快照异常少，先
`owb wait --network-idle true` 再读一次。

### ⚠️ 三层超时，别搞混（这里最容易白费功夫）

| 哪一层        | 参数                | 默认                                        | 上限                       |
| ---------- | ----------------- | ----------------------------------------- | ------------------------ |
| CLI 等 ctl 结果 | `--timeout <秒>`   | 120                                       | 300                      |
| 工具内部等待     | `--timeout-ms <毫秒>` | `open` 30000 / `wait` **10000** / `wait-user` 280000 | `wait` 110000            |
| 单条 CDP 调用  | 无                 | **30 秒**                                  | **硬编码，任何参数都改不了**         |

- ⚠️ **`--timeout` 不会传给工具**，它只放宽 CLI 等结果的那一层。想让 `owb open`
  等一个慢站超过 30 秒，写 `--timeout-ms 60000`；写 `--timeout 60` **毫无效果**。
- ⚠️ **`owb wait` 默认只等 10 秒**，不是"一直等"。等慢站要显式 `--timeout-ms 60000`。
- ⚠️ 工具内部等待超过 110 秒时，要**同时**加 `--timeout` 放宽 CLI 层，否则先撞上
  120 秒信封超时（报 `ctl call timeout`）。`wait-user` 是唯一例外，CLI 会自动放宽。
- ⚠️ `owb shot`、`owb eval` 撞到的 30 秒是 CDP 层硬超时，**调参数没用**——
  那是另一类病，见下面「`shot` 超时」。

## 常见任务

### 读需要登录才能看的内容

用户的登录态就在浏览器里，直接开：

```bash
owb open <文章 URL> --new-tab true
owb page --mode article
```

多页收集：`owb page` 找到"下一页"的编号 → `owb click @eN` → `owb wait` → 再读。

### 读评论区 / 论坛讨论串

评论、回帖这类内容**不是文章正文**——`--mode article` 认不出来，只会返回 0 字；
默认 `snapshot` 只画结构（谁在几分钟前发的、点赞/回复链接），同样看不到说了什么。
**评论串直接跳过 snapshot/article，一步到位用 text**：

```bash
owb open https://news.ycombinator.com/item?id=<id> --new-tab true
owb page --mode text        # 实测：整串评论正文都在，snapshot/article 都是空的
```

同样适用于 Reddit 帖子、V2EX 回复、知乎问题下的答案列表。

### 跨站汇总 / 交叉验证

真正有价值的用法：arxiv 论文页抓到仓库链接 → 开 GitHub 读 star/最近提交 →
得出"代码是否真实存在、仓库活不活跃"。这种结论必须跨站才能得出，单站抓取做不到。
配合 `task begin` 把这一串 tab 收在一个组里。

### 结构化提取用 eval

页面有规整结构时，`owb eval` 一次拿全比逐个 `page` 高效得多：

```bash
owb eval 'JSON.stringify([...document.querySelectorAll(".item")].slice(0,20).map(e=>({
  title: e.querySelector("h3")?.textContent.trim(),
  url: e.querySelector("a")?.href
})))'
```

⚠️ 返回是 `{"value":"<JSON 字符串>","type":"string"}`，要**解两层**。

⚠️ **选择器别写成并列的多个类**（如 `"mat-list-item, [class*=event]"`）——
外层容器和内层元素会各匹配一次，同一条数据出现两遍。实测抓地震列表时就这么
重复了。用一个**足够具体**的选择器，拿到结果先看条数对不对。

### `click` 报成功但页面看起来什么都没发生

`click` 走 `element.click()`（脚本触发，`isTrusted:false`）；`click-mouse` 走真实
CDP 鼠标事件（`isTrusted:true`）。多数网站两者一样，但**有些自定义交互组件会读
`event.isTrusted`，只认真实事件**——症状是"DOM 属性确实变了、应用自己的状态没
反应"。实测 NYT Connections 选词卡：`click()` 后底层 checkbox 的 `checked` 真的
变成 `true`，但格子不高亮、Submit 不解锁，换 `click-mouse` 点同一个 ref 才生效。
Reddit 的分享/外链卡片也一样。

判断依据：`click` 报了 `clicked:true` 却没有预期的视觉变化（**截图确认，别只信
返回值**），换 `click-mouse` 重试。普通表单/按钮仍优先 `click`，它更快。

⚠️ **`checked`/`aria-*` 不能作为"选中成功"的证据**——它们可能被 `click()` 正常
改动，但应用自己的状态是另一套东西，两者可能脱节。看视觉或看功能性副作用
（按钮解锁了没有），别只查 DOM 属性。

### 拖拽 / 画布绘图（canvas、看板、滑块）

`click` / `click-mouse` 都是"落点即抬"，模拟不了拖拽。**先试两次 `click-mouse`**
（点起点、点终点）——实测 chess.com 的棋盘这样就够了。确认站点不支持点选，
再上 `owb cdp` 三段式 `Input.dispatchMouseEvent`（mousePressed → mouseMoved →
mouseReleased），实测 Excalidraw 画矩形、Google 地图平移都可行。

⚠️ 中间的 `mouseMoved` **必须带 `buttons:1`**，漏了就是"光标动了元素没动"。
canvas 内容不是 DOM，`owb page` 看不见，只能 `owb shot` 确认。
**完整命令模板和地图类的坑在 `field-notes.md`。**

### 慢站提速

`open` 默认等页面完全加载（所有图片、脚本）。只是要读内容的话，
`--wait-until domcontentloaded` 明显更快，实测内容不减：

| 站点   | 默认    | domcontentloaded |
| ---- | ----- | ---------------- |
| 开源中国 | 7.7s  | **2.4s**         |
| CSDN | 9.6s  | **5.0s**         |
| 新浪新闻 | 18.7s | **12.1s**        |

要点后面还要交互（点按钮、等 JS 绑定）时，仍用默认或配 `owb wait`。

### 下载文件别用错命令

⚠️ `owb download` 和 `owb file fetch` 名字看着像近义词，行为其实不一样，
**只有后者会把文件复制进沙盒 `work/downloads/` 目录**：

- `owb download`——模拟浏览器自己触发下载（点下载按钮/链接），文件必然
  落在**浏览器所在机器**真实的系统下载目录（Chrome 下载 API 只能存到那儿）。
  返回里**没有** `dir`/`originalPath` 字段。
- `owb file fetch`——daemon 自己直接拉取一个 URL，拉完再复制一份进
  `work/downloads/`，返回同时给 `path`（沙盒内复制件）、`originalPath`、
  `dir`。**要一个能在项目沙盒里稳定引用的路径，用这个。**

⚠️ 中转模式下这两条落在**不同的机器上**（浏览器在用户机、daemon 在你这边），
差别更要命，见 `relay.md`。

### 上传文件

⚠️ `owb upload` **不接受文件路径**，要的是 `files: [{name, base64}]`
（页面内构造 File 派发 change，绕开文件系统，中转模式下也能用）。

```bash
node -e 'const fs=require("fs"),p=process.argv[1];
console.log(JSON.stringify({ref:"@e12",files:[{name:require("path").basename(p),
base64:fs.readFileSync(p).toString("base64")}]}))' "C:\Users\me\a.txt" > /tmp/up.json
owb upload --args "$(cat /tmp/up.json)"
```

### 调试用户自己的网站

⚠️ **顺序很重要**：`net start` 必须在导航**之前**，否则拿到的是一批没有 URL 的
孤儿记录（`orphanRecordsHidden` 会告诉你丢了多少条）。

```bash
owb net start                              # ← 先开
owb open http://localhost:3000
owb net list --sort-by duration --limit 10 # 最慢的十个（--sort-by size 看最重的）
owb net detail --request-id <id>           # 单条完整头+body
owb debug console                          # 页面报错
owb har start && owb open <页> && owb har save --args '{"filename":"排查记录"}'
```

⚠️ **不要写 `har stop` 再 `har save`**。`har save` 内部**已经包含 stop**；
先手动 stop 会销毁录制器，`har save` 报 `NOT_RECORDING` 且**数据永久丢失**。
⚠️ 有活动任务时 `har save` 固定落到 `tasks/<任务 id>/recording.har`，
**`filename` 会被忽略**（跟任务归档放一起），别以为参数没生效。

抓包只是入口。**HAR 转重放脚本、两份 HAR 对比漂移、断言校验、hook 加密函数、
下断点读冻结现场、全局搜脚本源码、改写脚本、离线验签、TLS 指纹重放——
这一整条线在 `debugging.md`，遇到"这个参数怎么算出来的"类问题去读它。**

### 响应式适配审计

```bash
owb env set --width 390 --height 844 --mobile true --touch true
owb shot --out mobile.png
owb eval '<检查横向溢出、过小的字、过小的点击区>'
owb env compare                             # 想核对模拟前后差异
owb env reset                               # ⚠️ 必须恢复
```

⚠️ 设了 `--width 390` 但 `innerWidth` 仍是 1200？**不是工具失效**——说明该站点
没有响应式 viewport meta，浏览器给了它默认布局视口。这本身就是审计结论。

⚠️ `env set` 会一直生效到 `env reset`。用完不恢复，用户的浏览器会一直卡在模拟状态。

视口用扁平参数；`network`/`geolocation`/`permissions` 是对象，走 `--args`：

```bash
owb env set --args '{"network":{"latency":300,"download":400000,"upload":400000}}'
```

### 撞到验证码 / 要扫码 / 要输密码

不要试图绕过，也不要代填凭据。交还用户：

```bash
owb handoff --reason "请在这个页面完成扫码登录，好了告诉我"
owb wait-user --condition text --text "退出登录"    # ← 等一个"登录后才会出现"的标志
```

⚠️ **`owb wait-user` 裸调等的是 URL 变化**（默认 `condition: url_change`），
超时 280 秒。可扫码登录、SPA 登录**很多都不换 URL**——裸调会静默干等近五分钟
然后超时。**登录场景一律显式给条件**：`--condition text --text "<登录后才出现的文字>"`
或 `--condition selector --selector "<头像/用户名的选择器>"`。

然后**明确告诉用户你需要他做什么**。他弄完后用 `owb page` 确认状态再继续。

### 保存登录态

```bash
owb state save 某站      # cookie + localStorage + IndexedDB
owb state list           # 看存了哪些
owb state load 某站      # 换机器/换 profile 后恢复
owb state delete 某站    # 过期了删掉
```

⚠️ 存下来的是**明文登录凭据**，落在 `work/states/` 下（已 gitignore）。
打包或分享仓库前注意别外泄。

### 固化流程，以后一条命令重放

`flow save` 按**时间窗**抓取这段时间里的操作，所以必须在任务上下文里跑
（没有活动任务会报 `NEED_TASK`）：

```bash
owb task begin "每周报表"
owb open <页面> --new-tab true && owb click @eN && ...
owb flow save 周报
owb task end && owb tab close-group
owb flow list                  # 看有哪些
owb flow run 周报              # 以后一条命令重放
```

⚠️ 两个回放注意事项：

- **录制期间别做无关操作**。时间窗内的所有调用都会被录进去，包括你顺手开的
  别的标签页。
- **回放需要安静的浏览器**。录制的 tabId 跨会话无意义会被剥掉，每步改用
  「当前活动标签页」解析；此时若用户正在切标签、或另有流程在跑，就会
  `AMBIGUOUS_TAB`。想保留原 tabId 传 `--keep-tab-ids true`；想让某步失败后
  继续往下走传 `--continue-on-error true`。

## 参数与输出

- `--foo-bar 值` → 工具参数 `foo_bar`；能 JSON 解析就解析（`--new-tab true`）
- `--tab <id>` 指定标签页；不给就用当前活动的
- `--out <文件>` 截图/PDF 落盘路径
- `--args '<json>'` 传别名没覆盖的参数（优先级最高）
- `--raw` 拿完整 result 信封（含 error 详情）、`--compact` 单行 JSON、
  `--no-autostart` 不自动拉 daemon
- 逃生口：`owb call <底层工具名> --args '<json>'`、`owb cdp` 直发 CDP

输出规则：成功 → data JSON 到 stdout；失败 → stderr 一行 `error CODE: message`，
退出码非 0（用法错误是 2）。

**返回里这几个下划线开头的字段是 CLI 加的，不是页面数据**：

| 字段                        | 含义                                       |
| ------------------------- | ---------------------------------------- |
| `_clipped` + `_hint`      | 返回超过 60KB 被截断了，按 `_hint` 缩小范围重取          |
| `_nodesOmitted`           | `page` 的 `nodes` 结构化重复字段被摘掉了（内容都在 `lines` 里） |
| `_harOmitted`             | HAR 正文没打到 stdout（该用 `har save` 落盘）       |

⚠️ **截图和 PDF 自动落盘**，stdout 只回 `{savedTo, bytes}`，不会把几百 KB 的
base64 灌进你的上下文。长页面整页截图加 `--full-page true`。

### ⚠️ 复杂 `--args` / `eval` 别在命令行里硬拼引号

这是实测最浪费时间的一类失败——**不是工具的问题，是 shell 引号嵌套的问题**，
但症状看着像工具坏了：

```
用法错误：--args 不是合法 JSON：Bad escaped character in JSON at position 38
error EVAL_EXCEPTION: Uncaught: SyntaxError: missing ) after argument list
```

两个高频触发点：**Windows 路径**（`C:\Users\...` 里的 `\U` 在 JSON 里是非法转义）、
**JS 表达式里套字符串**（三层引号必然打架）。

**别硬转义，把内容落到文件再读进来**——表达式写进 `.js`，用 node 的
`JSON.stringify` 包成 args，一次成功：

```bash
cat > /tmp/expr.js << 'EOF'
(function(){ return JSON.stringify({ n: document.querySelectorAll("a").length }); })()
EOF
node -e 'console.log(JSON.stringify({expression:require("fs").readFileSync(process.argv[1],"utf8")}))' \
  /tmp/expr.js > /tmp/eval-args.json
owb eval --args "$(cat /tmp/eval-args.json)"
```

简单参数照旧直接写（`owb fill @e3 "关键词"`），这套只在引号打架时用。

### 滚动之后没有新内容？

`owb scroll --args '{"to":"bottom"}'` 返回 `{y, maxY, atBottom}`，先看这几个值确认
真滚到底了。滚到底但 `--since-last` 显示 `added=0`，三种可能：**该页本来就没有更多
内容**（固定网格不是信息流）／**需要点「加载更多」**（回 `owb page` 找那个按钮）／
**虚拟滚动**（DOM 节点数恒定，此时 `changed` > 0）。先用返回值区分，别急着认为工具失灵。

## 现实环境：症状 → 判断

这些不是故障，是真实浏览器里必然会遇到的情况。**下表按症状索引，详情在
`field-notes.md`**——对上号了再去读，别提前把全部细节读进上下文。

| 症状                                  | 一句话判断                                                        | 细节         |
| ----------------------------------- | ------------------------------------------------------------ | ---------- |
| 页面里有跟主题无关的浮层按钮（翻译/收藏/快捷设置）          | 是用户装的**别的扩展**注入的，`extensionUiHidden` 只剔得掉一部分。**别去点**          | field-notes |
| 动画不动 / 视频卡 `readyState:0` / 游戏没反应   | **整个 Chrome 窗口没有系统焦点**（不是标签页没激活）。跑一次下面的诊断命令                    | field-notes |
| `owb shot` 卡满 30 秒超时                | 先补一条 `owb eval "1+1"` 分叉：也超时=标签页真死了（关掉重开）；秒回=窗口没焦点（关了重开没用）     | field-notes |
| 快照为空、带 `renderNote`                 | 标签页没在渲染，已自动前台化重试；`renderNote` 会说清是内容问题还是窗口焦点问题               | field-notes |
| 403 / 空快照 / `httpErrorHint`         | 反爬拒绝（澎湃、知网、部分电商），**换思路**，别在空快照上反复分析                          | field-notes |
| `FORBIDDEN` + `cannot be scripted` / `chrome-extension:// URL` | 这类地址 Chrome **结构上就不允许调试**（见下），**不是故障，重试无用**，换条路 | 见下 |
| 任何操作都 `FORBIDDEN`，页面像是变了个样          | 标签页被 OneTab 一类扩展**整个换掉**了。`tab list` 确认，新标签页重开               | field-notes |
| `FORBIDDEN` 且提到 interstitial        | Chrome 安全拦截页（证书错误），**无解**，让用户在浏览器里处理                         | field-notes |
| PDF 网址三种模式都读不出正文                    | Chrome PDF 阅读器在独立沙盒视图里，**架构上够不到**。找 HTML 版本，或截图              | field-notes |
| 搜索结果里出现 `derosnopS` 一类乱码词           | 反爬诱饵文本（人眼看不到），**当噪音跳过**                                      | field-notes |
| 导航到 `docs.google.com/**/create`      | ⚠️ **光是访问就会在用户账号里真建一个文件**，且新建空文件删不掉。别导航到这类地址                 | field-notes |
| stderr 出现 `扩展暂时不可达…N s 后重试`         | MV3 worker 被回收，**正常**，命令会自己重试（累计约 35 秒）到成功                   | 见下          |
| 退避跑完仍 `NO_EXTENSION`                | 这次不是空闲回收，是**脚本本身崩了**，心跳唤不醒。**别再等**，直接报告用户                    | 见下          |
| 导航就是慢                               | 219 站实测 p50 4.7s / p90 15s / p99 30s。超 30 秒基本是站点问题，用 `--timeout-ms` 放宽或换 `domcontentloaded` | —          |

### Chrome 结构性禁止调试的地址

有一类 URL **`open` 会成功、之后每一条命令都 `FORBIDDEN`**：

- `chromewebstore.google.com`（错误文案：`The extensions gallery cannot be scripted`）
- `chrome://*`（设置、扩展管理、历史…）
- `devtools://*`
- **别的扩展**的 `chrome-extension://` 页面

这是 Chrome 自己的安全边界，不是 OWB 的 bug，**换标签页、重试、加 `--force` 全都没用**。
`open` 的返回里会带 `attachHint` 提前说破——看到它就别再往下调 `page`/`eval` 了。

绕法只有换信息源：Web Store 的条目改用它的公开分享页或搜索引擎缓存；
`chrome://` 的信息（装了哪些扩展、设置项）**只能让用户自己看**，你够不到。

窗口焦点诊断（**两个信号都要查，只查一个会漏判**）：

```bash
owb eval 'document.visibilityState + " hasFocus=" + document.hasFocus()'
```

- rAF/动画/视频卡住 → 跟 `visibilityState` 走（实测有 `hasFocus()` 为 true
  但 `visibilityState` 仍 hidden、rAF 照样不触发的组合）
- `shot` 卡满 30 秒 → 跟 `hasFocus()` 走（实测有页面明明 `visible`、但
  `hasFocus()` 为 false、合成器不产帧的组合）

任一个不对劲，就提醒用户**把整个浏览器窗口切到系统前台**，而不是反复重试或
断定工具坏了。这是浏览器的省电节流设计，没有 CDP 层面的绕过办法
（`Emulation.setFocusEmulationEnabled` 试过，无效，别再往这个方向试）。

## 出错怎么办

| 错误                                           | 含义                | 动作                                                                                          |
| -------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------- |
| `NO_EXTENSION`                               | 扩展没连              | CLI 已自动退避重试约 35 秒；**跑完还失败就别再等**（脚本崩了心跳唤不醒），告诉用户检查扩展                                          |
| `REF_STALE`                                  | 编号过期              | 重新 `owb page`                                                                               |
| `AMBIGUOUS_TAB`                              | 多个标签页都匹配，**或**你没给 `--tab` 而活动 tab 是用户自己的页面 | `owb tab list` 拿 id，加 `--tab`。后者多半是你用了 `--active false` 却没带 `--tab`——用 `open` 返回的那个 tabId |
| `BAD_ARGS`                                   | 参数给错/给重了          | 错误消息里带合法值，照着改；不确定参数名去查 `reference.md`                                                       |
| `PAUSED`                                     | 页面停在断点            | `owb debug resume`                                                                          |
| `FRAME_NOT_FOUND`                            | iframe 找不到        | `owb frames` 看清单；`contextId:null` 的是跨域框架，求值不了                                               |
| `TIMEOUT`                                    | 主线程忙（最常见）/ 断点 / 模态框 | 先 `owb wait --network-idle true` 再重试；要等更久用 **`--timeout-ms`**（不是 `--timeout`）。**连 `shot` 都超时时先补 `owb eval "1+1"` 分叉** |
| `ctl call timeout`                           | 撞上 CLI 那层信封超时     | 你把工具内部等待调过 110 秒了，同时加 `--timeout <秒>`                                                       |
| `NEED_TASK`                                  | 没有活动任务            | `owb task begin "<标题>"` 之后重来                                                                |
| `NOT_RECORDING`                              | 录制器已销毁            | 你先 `har stop` 了；`har save` 自带 stop，数据已丢，重录                                                  |
| `FORBIDDEN` + interstitial                   | Chrome 安全拦截页      | 无解，让用户在浏览器里处理证书警告                                                                           |
| `FORBIDDEN` + not in an OWB-managed group    | 你在关一个**用户自己的** tab | 这是护栏不是故障。先 `owb tab list` 核对 tabId；确实该关再考虑 `--force true`                                    |
| 快照带 `renderNote`                             | 标签页没在渲染           | 已自动前台化重试；`renderNote` 会说清是内容问题还是**窗口没有系统焦点**                                                |

## 命令地图

16 个组、82 条命令。**这里只列名字帮你知道"有没有"，参数去 `reference.md` 查，
或 `owb help <组名>`。**

| 组          | 命令                                                                     | 用途                     |
| ---------- | ---------------------------------------------------------------------- | ---------------------- |
| **基础**     | open back forward reload page shot click click-mouse fill keys scroll eval wait frames status cdp | 打开、读、点、填、按键、等          |
| **tab**    | tab list / find / close / close-group                                  | 标签页与清场                 |
| **net**    | net start / stop / list / detail / initiator / capture                 | 抓包 → `debugging.md`    |
| **har**    | har start / save / stop / status / to-replay / diff / assert            | 录制与加工 → `debugging.md` |
| **hook**   | hook preset / fn / remove / status / logs                              | 函数与请求钩子 → `debugging.md` |
| **debug**  | debug break-xhr / break-fn / break-remove / frames / step / resume / console；**`oracle` 是顶层命令**（写 `owb oracle`，不是 `owb debug oracle`） | 断点与调用帧 → `debugging.md` |
| **script** | script list / source / search / patch / unpatch / watch / watch-remove  | 脚本搜索改写 → `debugging.md` |
| **verify** | verify signer / replay / evidence                                      | 离线验签、TLS 重放、取证 → `debugging.md` |
| **cookie** | cookie get / set / delete                                              | cookie 读写              |
| **state**  | state save / load / list / delete / export / import                    | 登录态存取                  |
| **env**    | env set / reset / compare                                              | 设备/网络/地理/UA 模拟         |
| **file**   | download、upload、pdf 是**顶层**命令；只有 `file fetch` 带 `file ` 前缀        | 下载、上传、导出 PDF           |
| **task**   | task begin / end / list                                                | 任务分组与归档                |
| **flow**   | flow save / run / list                                                 | 流程固化与回放                |
| **human**  | handoff、wait-user                                                      | 人机交接                   |
| **daemon** | daemon-status、reload-ext                                               | 看模式/中转状态、重载扩展          |

## 边界

这些操作作用在真人账号上，很多不可撤销。

**做之前必须问用户**：发消息/发帖/评论/发邮件、提交表单、下单支付、删除内容、
改账号设置、授权第三方。

**永远不做**：输入密码/验证码/支付信息（撞到就 `handoff`）、绕过人机验证、
打开与任务无关的私密页面（私信、邮箱、账单）。

读取和浏览直接做。**改变状态的操作，先说清楚要做什么，等用户点头。**

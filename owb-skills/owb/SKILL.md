---
name: owb
description: 用 owb 命令驱动用户自己的浏览器——带着用户已登录的账号去读页面、查资料、填表、走流程、调试网站、审计适配。当任务需要「打开某个网页看看」「把这几页内容整理一下」「帮我在某站上操作」「我的网站前端出问题了」，或任何需要用户登录态/真实浏览器环境才能完成的事情时使用。
---

# owb — 驱动用户的真实浏览器

`owb` 操作的是**用户此刻正在用的那个浏览器**：他登录过的账号、他的设置、他开着的标签页。
所以你能看到只有登录后才存在的内容，也能替他完成需要身份的操作。

同样因此：**你的每一步都作用在真人的账号上**。读可以随便读，改要先问。

以下所有做法都在 **217 个真实站点、六轮以上完整跑动**（累计 1300+ 站次）中
验证过，标 ⚠️ 的是实测踩过的坑。

## 开始之前

```bash
owb          # 自检
```

- `✓ daemon` + `✓ 扩展已连接` → 开工
- `✗ 扩展未连接` → **停下来告诉用户**点浏览器工具栏的扩展图标看状态。别硬调工具，
  只会一直 `NO_EXTENSION`
- 命令不存在 → `npm i -g open-web-bridge` 然后 `owb setup`

## 核心循环：看 → 指 → 动

`owb page` 把页面变成带编号的清单，每个可交互元素一个 `@eN`，你直接用编号操作，
不用猜 CSS 选择器。

```bash
owb open https://example.com
owb page                      # @e1 @e2 … 各自带角色、文字、href
owb fill @e3 "关键词"
owb click @e5
owb wait --text "结果"         # 等就绪，别 sleep
```

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

### ⚠️ 编号会过期

页面跳转或重渲染后旧编号失效，报 `REF_STALE`。**重新 `owb page` 拿新编号**，
别拿旧的重试。

### ⚠️ 快照被截断了要看出来

约四分之一的站点首屏快照就会触顶（默认 20000 字符 / 400 节点）。截断时返回里有
`truncated: true` 和 `omittedNodes`。**看到就调大或缩小范围**：

```bash
owb page --max-nodes 1200 --max-chars 60000    # 要全量
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

| 模式 | 用在哪 | 返回字段 |
|---|---|---|
| `owb page`（默认 snapshot） | 要**操作**页面：找按钮、填表、点链接 | `lines` |
| `owb page --mode article` | **文章页**读正文，输出干净 markdown | `content` |
| `owb page --mode text` | 列表页、结构不规则的页面，要全部文字 | `text` |

💡 **三种模式都有 `text` 字段**——它是各模式主字段的别名。写脚本处理输出时
优先读 `text`，就不用按模式切字段名。

⚠️ **列表页/论坛首页用 article 会返回 0 字**——它们本来就没有"正文"，这是正确行为
不是故障（V2EX、牛客、各种榜单页都是如此）。空返回时看 `reason` 字段，会说明原因。

## 等待：用 wait，不要用 sleep

```bash
owb wait --selector ".result-item"      # 等元素出现
owb wait --text "共 128 条"             # 等文字出现
owb wait --url-pattern "search"         # 等跳转
owb wait --network-idle true            # 等请求停下（SPA 首选）
```

⚠️ **SPA 站点 `open` 返回 `loadCompleted:true` 不代表内容渲染完了**。实测澎湃新闻
2.3 秒就返回完成，但快照只有 6 个元素。遇到快照异常少，先
`owb wait --network-idle true` 再读一次。

## 常见任务

### 读需要登录才能看的内容

用户的登录态就在浏览器里，直接开：

```bash
owb open <文章 URL>
owb page --mode article
```

多页收集：`owb page` 找到"下一页"的编号 → `owb click @eN` → `owb wait` → 再读。

### 读评论区 / 论坛讨论串

评论、回帖这类内容**不是文章正文**——`--mode article` 认不出来，只会返回 0 字
（这是正确行为，见上表警告）；默认 `snapshot` 只画结构（谁在几分钟前发的、
点赞/回复链接），同样看不到说了什么。两个都试了才想到用 `text` 模式就晚了，
**评论串直接跳过 snapshot/article，一步到位用 text**：

```bash
owb open https://news.ycombinator.com/item?id=<id>
owb page --mode text        # 实测：整串评论正文都在，snapshot/article 都是空的
```

同样适用于 Reddit 帖子、V2EX 回复、知乎问题下的答案列表。

### 跨站汇总 / 交叉验证

真正有价值的用法。例：查一篇论文有没有可用的开源实现——

```bash
owb open https://arxiv.org/abs/XXXX
owb eval '<抓摘要和页面里的代码链接>'
owb open https://github.com/<抓到的仓库>
owb eval '<读 star / 最近提交时间>'
```

结论（"代码是否真实存在、仓库活不活跃"）必须跨站才能得出，这是单站抓取做不到的。

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

`click` 走的是 `element.click()`（脚本触发，`isTrusted:false`）；`click-mouse`
走真实 CDP 鼠标事件（`isTrusted:true`）。多数网站两者效果一样，但**有些站的
自定义交互组件会读 `event.isTrusted`，只认真实事件**——`click` 在这类元素上
会稳定复现"DOM 属性确实变了、但应用自己的状态没反应"：NYT Connections 选词卡
就是这样，底层是个 `visually-hidden` 的原生 `<input type="checkbox">`，
`click()` 后 `checked` 属性真的变成了 `true`，但格子不会高亮、"Submit"
按钮也不会解锁——只有 `click-mouse` 点同一个 ref 才会让游戏自己的状态真正
更新。Reddit 上点"分享"卡片、外链卡片时也遇到过同样的静默无效。

判断依据：`click` 报了 `clicked:true` 却没有预期的视觉/状态变化（截图确认，
别只信返回值），换 `click-mouse` 重试。反过来，`click` 更快、没有光标动画，
普通表单/按钮优先用它，遇到这个具体症状再升级。

⚠️ **`checked`/`aria-*` 这类底层 DOM 属性不能作为"选中成功"的证据**——它们
可能被 `click()` 正常改动，但应用自己的状态（决定按钮是否可用、格子是否
高亮）是另一套东西，两者可能脱节。真要确认，看视觉（截图）或看功能性的
副作用（按钮解锁了没有），别只查 DOM 属性。

### 拖拽 / 画布绘图（canvas、看板、滑块）

`click` / `click-mouse` 都是"落点即抬"，模拟不了拖拽——canvas 画图、看板卡片
拖动排序、滑块、图片裁剪框都需要真正的 mousedown → 移动 → mouseup 序列。
`owb cdp` 逃生舱直发三条 `Input.dispatchMouseEvent` 就够，实测在 Excalidraw
上画矩形一次成功：

```bash
owb cdp --args '{"method":"Input.dispatchMouseEvent","params":
  {"type":"mousePressed","x":300,"y":250,"button":"left","buttons":1,"clickCount":1}}'
owb cdp --args '{"method":"Input.dispatchMouseEvent","params":
  {"type":"mouseMoved","x":500,"y":400,"button":"left","buttons":1}}'
owb cdp --args '{"method":"Input.dispatchMouseEvent","params":
  {"type":"mouseReleased","x":500,"y":400,"button":"left","buttons":0,"clickCount":1}}'
```

⚠️ 中间的 `mouseMoved` 必须带 `buttons:1`（表示左键仍按住），否则页面收到的是
"没按键的移动"，很多拖拽实现靠这个字段判断是否在拖——漏了这个参数，视觉上
光标动了但元素纹丝不动。canvas 画图这类场景 `owb page` 的语义快照看不到
任何东西（canvas 内容不是 DOM），只能靠 `owb shot` 截图确认画没画上。

同样的三段式在 Google 地图这类 WebGL 瓦片地图上一样能用来拖动平移视野，
实测成功；多试几个 `mouseMoved` 中间点（而不是只有起止两点）让轨迹更连续，
拖拽实现更容易识别成真的在拖。⚠️ 但如果松手（`mouseReleased`）那一点正好
落在一个带标签的兴趣点（地名、门店图标）上，地图会把这次操作同时当成
"点了那个点"，弹出信息卡——这不是 bug，是地图自己用移动距离/轨迹分辨
"拖拽"和"点击"，鼠标事件类型上看不出区别。只想纯平移、不想意外弹窗时，
让终点落在空白区域（比如水面、空地），别正好停在图钉或文字标签上。

⚠️ 不是所有棋盘/网格类界面都需要完整拖拽序列——先试**两次 `click-mouse`**
（点起点选中，再点终点落子），比直接上三段式 `Input.dispatchMouseEvent`
更简单。实测 chess.com 的棋盘就是这样：点一下棋子选中，再点一下目标格，
跟真实鼠标拖棋子放下的效果完全一样，走法正确记谱。只有确认站点**不**支持
点选（选中后目标格没有高亮提示、点了没反应）才需要升级成完整的
mousedown→move→mouseup。

### 慢站提速

`open` 默认等页面完全加载（所有图片、脚本）。只是要读内容的话，
`--wait-until domcontentloaded` 明显更快，实测内容不减：

| 站点 | 默认 | domcontentloaded |
|---|---|---|
| 开源中国 | 7.7s | **2.4s** |
| CSDN | 9.6s | **5.0s** |
| 新浪新闻 | 18.7s | **12.1s** |

要点后面还要交互（点按钮、等 JS 绑定）时，仍用默认或配 `owb wait`。

### 下载文件别用错命令

⚠️ `owb download` 和 `owb file fetch` 名字看着像近义词，行为其实不一样，
**只有后者会把文件复制进沙盒 `work/downloads/` 目录**：

- `owb download`——模拟浏览器自己触发下载（点下载按钮/链接），文件必然
  落在用户真实的系统下载目录（Chrome 下载 API 本来就只能存到那儿，改不了）。
  返回里**没有** `dir`/`originalPath` 字段，`path` 就是系统下载目录里的
  真实路径，不会有 `work/downloads/` 版本。
- `owb file fetch`（底层是 `daemon.download`）——daemon 自己直接拉取一个
  URL，拉完再复制一份进 `work/downloads/`，返回同时给 `path`（沙盒内
  复制件）、`originalPath`（真实下载目录原件）、`dir`（沙盒内相对路径）。
  **要一个能在项目沙盒里稳定引用的路径，用这个，不是 `download`。**

实测在这两个命令之间搞混过一次——以为 `owb download` 也会给沙盒路径，
结果拿到的 `path` 是用户系统下载目录的真实路径，返回里连 `dir` 字段都
没有。两个命令都能正常工作，不是谁坏了，是命令选错了。

### 调试用户自己的网站

⚠️ **顺序很重要**：`net start` 必须在导航**之前**。

```bash
owb net start                              # ← 先开
owb open http://localhost:3000
owb net list --sort-by duration --limit 10 # 最慢的十个
owb net list --sort-by size --limit 10     # 最占带宽的十个
owb net list --url-pattern "api/"          # 只看接口
owb net detail --request-id <id>           # 单条完整头+body
owb debug console                          # 页面报错
```

如果顺序反了（先 `open` 再 `net start` 再 `reload`），会收到一批只有响应事件、
没有 URL 的记录——返回里 `orphanRecordsHidden` 会告诉你有多少条因此被丢掉。
**看到这个数字大，就是在提醒你抓包起晚了。**

**留证据给同事——录 HAR 的正确顺序**：

```bash
owb har start          # 开录
owb open <目标页>       # 干活
owb har save --args '{"filename":"排查记录"}'   # ← 停止 + 落盘，一步到位
```

⚠️ **不要写 `har stop` 再 `har save`**。`har save` 内部**已经包含 stop**；
先手动 stop 会销毁录制器，`har save` 报 `NOT_RECORDING` 且**数据永久丢失**。
`har stop` 只在你确实只想停、不想存时用。

### 响应式适配审计

```bash
owb env set --width 390 --height 844 --mobile true --touch true
owb shot --out mobile.png
owb eval '<检查横向溢出、过小的字、过小的点击区>'
owb env reset                               # ⚠️ 必须恢复
```

⚠️ 设了 `--width 390` 但 `innerWidth` 仍是 1200？**不是工具失效**——说明该站点
没有响应式 viewport meta，浏览器给了它默认布局视口。这本身就是审计结论。

⚠️ `env set` 会一直生效到 `env reset`。用完不恢复，用户的浏览器会一直卡在模拟状态。

视口用扁平参数；`network`/`geolocation` 是对象，走 `--args`：

```bash
owb env set --args '{"network":{"latency":300,"download":400000,"upload":400000}}'
```

### 撞到验证码 / 要扫码 / 要输密码

不要试图绕过，也不要代填凭据。交还用户：

```bash
owb handoff --reason "请在这个页面完成扫码登录，好了告诉我"
owb wait-user                    # 等他弄完，你自动接管
```

然后**明确告诉用户你需要他做什么**。他弄完后用 `owb page` 确认状态（比如页面上
出现了头像/用户名）再继续。

### 保存登录态

```bash
owb state save 某站      # cookie + localStorage + IndexedDB
owb state load 某站      # 换机器/换 profile 后恢复
```

### 固化流程，以后一条命令重放

⚠️ `flow save` **必须先开任务上下文**——它按时间窗抓取这段时间里的操作：

```bash
owb task begin "每周报表"      # ← 先开，否则 flow save 报 NEED_TASK
owb open <页面> && owb click @eN && ...
owb flow save 周报
owb flow run 周报              # 以后一条命令重放
```

⚠️ 两个回放注意事项：
- **录制期间别做无关操作**。时间窗内的所有调用都会被录进去，包括你顺手开的
  别的标签页。
- **回放需要安静的浏览器**。录制的 tabId 跨会话无意义会被剥掉，每步改用
  「当前活动标签页」解析；此时若用户正在切标签、或另有流程在跑，就会
  `AMBIGUOUS_TAB`。

## 参数与输出

- `--foo-bar 值` → 工具参数 `foo_bar`；能 JSON 解析就解析（`--new-tab true`）
- `--tab <id>` 指定标签页；不给就用当前活动的
- `--out <文件>` 截图/PDF 落盘路径
- `--args '<json>'` 传别名没覆盖的参数
- 逃生口：`owb call <底层工具名> --args '<json>'`、`owb cdp` 直发 CDP

输出规则：成功 → data JSON 到 stdout；失败 → stderr 一行 `error CODE: message`，
退出码非 0（用法错误是 2）。

⚠️ **截图和 PDF 自动落盘**，stdout 只回 `{savedTo, bytes}`，不会把几百 KB 的
base64 灌进你的上下文。任何工具返回超过 60KB 会被截断并附 `_hint` 说明怎么拿全量。

### 滚动之后没有新内容？

`owb scroll --args '{"to":"bottom"}'` 会返回 `{y, maxY, atBottom}` —— 先看这几个值
确认真的滚到底了。滚到底但 `--since-last` 显示 `added=0`，通常是这三种情况：

1. **该页本来就没有更多内容**（很多首页是固定网格，不是信息流）
2. **需要点「加载更多」**——回 `owb page` 找那个按钮
3. 页面用了虚拟滚动，DOM 节点数恒定（此时 `changed` 会 > 0）

别急着认为工具失灵，先用返回值和快照区分是哪一种。

## 现实环境里的几件事

这些不是故障，是真实浏览器里必然会遇到的情况，知道了就不会误判。

**页面里可能有别的扩展的东西**。用户装了翻译、收藏、标签管理类扩展时，
它们会往页面注入悬浮按钮。快照会剔除已知框架（Plasmo/CRXJS）挂载的这类元素
并记在 `extensionUiHidden` 里。

但**剔不干净**——扩展的注入方式五花八门，且很多是划词/悬停时才出现，无法穷举。
自己认一下：像 `图片翻译`、`语音翻译`、`快捷设置`、`添加到收藏夹`、`关闭(Esc)`
这类**与当前页面主题毫无关系**的按钮，基本都是别的扩展的浮层，**别去点**。
判断依据很简单——它和你正在做的事、和页面在讲的内容有关系吗？

**电商站的搜索结果里可能混着看不懂的乱码词**。实测 eBay 搜索页 `text`
模式里出现过 `derosnopS`——倒过来读是"Sponsored"，是网站专门放给爬虫看的
诱饵（真实元素是 `color: transparent` + `aria-hidden="true"`，人眼和
屏幕阅读器都看不到，只有不分可见性硬抓文字的工具才会读到）。遇到这种
明显不是正常语言的短词，当噪音跳过就好，不用纠结它是什么意思。

**⚠️ Google Docs/Sheets/Slides/Forms 的 `/create` 类地址，光是导航过去
就会真的建一个文件**——不是"打开一个创建页面等你点确认"，是访问这个
URL 本身（`docs.google.com/document/create`、`.../spreadsheets/create`、
`.../forms/create` 等）就已经在用户真实的 Google 账号里落下一个持久化的
空白文档/表格/表单，标题通常是"未命名的文档"这类默认值。实测踩过两次
（一次 Sheets、一次 Forms），且两次都发现新建的空白文件"移到回收站"选项
是**禁用**的（Google Workspace 对完全没有任何编辑过的全新文档就是这个
行为，不是权限或工具的问题，手动在浏览器里点也一样删不掉，得等文档有
过至少一次内容变更才能进回收站）。这类地址不是"看看创建页长什么样"就
能无副作用撤销的——**如果任务不是真的要新建一个文档，就别导航到这类
`/create` 地址**；如果已经手滑创建了，别在禁用的删除按钮上反复尝试，
如实告诉用户账号里多了个空文件，他自己删更快。

**标签页可能被别的扩展抢走**。OneTab 一类工具会把标签页整个换成自己的页面，
此时任何操作都会报 `FORBIDDEN`。**别重试**，先 `owb tab list` 看这个 tab 现在
是什么，然后用新标签页重开目标地址。

**被站点拒绝是常态**。反爬严格的站点（澎湃、知网、部分电商）会直接回 403。
`owb open` 会给出 `httpErrorHint` 点明这一点。看到它就换思路——别在空快照上
反复分析。

**空快照要看 `renderNote`**。标签页没在渲染时元素全无布局盒，工具会自动前台化
重试并说明；如果仍空，让用户切到那个标签页。

**Chrome 窗口不是系统前台窗口时，一整类靠 rAF/可见性驱动的页面行为会卡住**。
不是"标签页不是激活页"这种 tab 内部状态，是**整个 Chrome 窗口**没有操作系统
级焦点（被别的窗口挡住）——`Page.bringToFront` 救不了这个，它只能把标签页
在自己窗口内切到激活位，管不到窗口本身有没有系统焦点。实测踩过三种表现：

- YouTube：`<video>` 卡在 `readyState:0`（HAVE_NOTHING），画面转圈不进度
- Ctrip：请求被拦截返回极简响应，页面渲染异常（间接受影响，非直接因果）
- play2048.co：棋盘上的方块（`requestAnimationFrame` 驱动 + worker 渲染）
  一个都不生成，按方向键完全没反应；同一个窗口后来自己变回系统前台
  （不受控，纯粹是真实环境里窗口焦点会变化），同一个页面重新打开就
  正常出方块、按键正常——反证了确实是窗口焦点的因果关系，不是巧合
- claude.com 官方博客：`--mode article/text` 只读到页头页脚导航，正文一个
  字都没有——真实原因是正文段落用了"滚动淡入"动画，一直
  `visibility:hidden`，触发动画的机制卡住了没跑（这条工具侧已经加了
  `hiddenContentNote` 自动提示，遇到别的类似情况可以照这个思路排查）
- Flightradar24（WebGL 实时地图）以及同一批次里一个内容很普通的 IMDB
  页面：`owb shot` 稳定卡满 30 秒超时，但 `owb eval "1+1"` 秒回——不是
  标签页卡死，是**合成器不产出新帧**，`Page.captureScreenshot` 在等一个
  永远等不到的帧（详见下面"`owb shot` 都超时"一节的完整判断步骤）

共同根因：Chrome 对隐藏窗口里的页面做资源节流（`requestAnimationFrame`
不触发、媒体缓冲暂停、合成器不产帧），这是浏览器的省电设计，不是 OWB 的
故障，也没有 CDP 层面的绕过方法——试过 `Emulation.setFocusEmulationEnabled`，
能把 `document.visibilityState` 骗成 `"visible"`，但 2048 的棋盘还是不
出来：这个开关只改 JS 能读到的属性值（给"测试我的页面在隐藏时表现对不对"
这种场景用的），改不了 Chrome 内部真正的渲染节流，没有必要再往这个方向试。

⚠️ **诊断时 `document.visibilityState` 和 `document.hasFocus()` 只查一个
会漏判——这两个信号会往不同方向脱节，各管各的症状**：

- rAF/动画/视频类卡住（棋盘不出方块、视频卡在 `readyState:0`）跟的是
  `visibilityState`。实测碰到过 `hasFocus()` 是 `true`（窗口其实有系统
  焦点）但 `visibilityState` 仍是 `"hidden"` 的组合，rAF 照样不触发——
  这条只信 `hasFocus()` 会漏判。
- `owb shot` 卡满 30 秒超时跟的是 `hasFocus()`。实测在 Flightradar24 上
  碰到过 `visibilityState` 是 `"visible"`（页面看着好好地显示在屏幕上）
  但 `hasFocus()` 是 `false`（焦点在另一个 App 上）的组合，合成器照样不
  产出新帧——这条只信 `visibilityState` 会漏判。

**两个都查，别只查一个**：

```bash
owb eval 'document.visibilityState + " hasFocus=" + document.hasFocus()'
```

**凡是页面看起来"该动的没动"——动画卡住、视频不转、游戏没反应、按键点击
了却没有任何视觉变化、或者连 `owb shot` 都超时**，跑一下上面这条，
任一个不对劲就提醒用户把整个浏览器窗口切到系统前台，而不是反复重试或
断定工具坏了。

**慢站真的慢**。219 站实测导航耗时 p50 4.7 秒、p90 15 秒、p99 30 秒。
超过 30 秒基本是站点问题不是工具问题，用 `--timeout` 放宽或换 `domcontentloaded`。

**扩展偶尔会掉线，但会自愈——仅限"活着但空闲"这一种情况**。Chrome 会回收
MV3 的后台脚本，扩展随后自动重连（约 30 秒内）。你会在 stderr 看到
`[owb] 扩展暂时不可达（NO_EXTENSION），1.5s 后重试…`（1.5s→4s→10s→20s
退避，累计约 35 秒）——**这是正常的，命令会自己重试到成功**，不用管。

但**这条自愈只对"idle 被回收"生效，对"脚本本身崩了"完全无效**——如果
单条命令自己的这轮退避（累计约 35 秒）都跑完了、还是 `NO_EXTENSION`，
别再手动多等几轮指望它自己好：`chrome.alarms` 心跳只能唤醒"活着但空闲"
的 worker，唤不醒"顶层解析就报错"的 worker（比如刚改过 background.js
手滑引入语法错误、`reload-ext` 又把这份坏脚本加载了进去）——这种情况下
心跳每次醒来重新执行的还是磁盘上同一份坏脚本，一样立刻失败，干等多久都
不会变。单条命令的重试耗尽后仍失败，就是该停下直接报告用户的信号，见
下面「出错怎么办」表的 `NO_EXTENSION` 行。

**有些页面根本无法检查**。Chrome 的安全拦截页（证书错误、隐私设置错误、
不安全下载警告）禁止 debugger 附着。`owb open` 会用 `attachHint` 提前告诉你，
`page` 会报 `FORBIDDEN`。**这类页面没有变通办法**——告诉用户去浏览器里看那个
标签页，证书有问题就修，或让他手动点过警告再继续。

**超时先想主线程**。`TIMEOUT` 最常见的原因不是断点，而是页面主线程被重 JS
占满（尤其还在加载时）。先 `owb wait --network-idle true` 再重试，别去找
根本不存在的断点。

**但如果连 `owb shot`（截图）都超时，先别急着当成"标签页卡死了"**。截图
走的是合成器帧捕获，正常不需要 JS 参与，理论上主线程再忙也不该卡住它——
但这条反过来也是诊断线索：**`shot` 超时时，先补一条 `owb eval "1+1"`**，
两种走向指向完全不同的病因和修法：

- **`eval` 也超时**（连最简单的表达式都没反应）：真的卡死了（渲染进程
  层面，不是"脚本正忙"）。实测在 Google 表格上连续碰到：`open` 到别的
  网址不生效（还停在原页面）、`eval "1+1"` 超时、`shot` 同样超时——
  几分钟后依然如此，不是"忙一会就好"，`owb debug resume` 也无济于事
  （`NOT_PAUSED`，不是断点问题）。**别在同一个标签页上反复重试**——
  `owb tab close` 关掉这个标签页、`owb open --new-tab true` 重开一个，
  新标签页立刻恢复正常响应。
- **`eval` 秒回、只有 `shot` 卡**：标签页根本没死，是**窗口没有系统
  焦点**的老问题（见上面"Chrome 窗口不是系统前台窗口"一节）换了个新
  症状——之前记录的是 rAF/动画类内容卡住，这次实测在 Flightradar24
  （WebGL 实时地图）和同一批次里一个普通的 IMDB 页面上都稳定复现：
  `Page.captureScreenshot` 本身在等一帧"合成好的画面"，窗口不在前台时
  合成器不产出新帧，这一等就是 30 秒硬超时，跟页面内容是不是 WebGL
  无关（普通页面一样会卡）。补一条 `owb eval "document.hasFocus()"`
  确认——`false` 就是这个原因，告诉用户把整个浏览器窗口切到前台，
  `owb tab close` 反而是白做——标签页本来就没坏，关了重开新标签页
  一样没有系统焦点，`shot` 照样卡 30 秒。

**直接打开 PDF 网址，`page` 三种模式都读不出内容**。Chrome 内置 PDF 阅读器
渲染在一个独立的沙盒视图里，DOM 和无障碍树（实测 `Accessibility.
getFullAXTree` 也查过，同样查不到正文）都看不进去——不是选择器没写对，是
架构上够不到，没有绕过办法。真要读 PDF 正文，找有没有 HTML 版本（arXiv 论文
详情页通常有「HTML (experimental)」链接，跳过去之后 `--mode article`
可以正常读）；没有 HTML 版本的 PDF 目前读不了正文，只能 `owb shot` 截图看，
或者告诉用户直接在浏览器里看。

## 出错怎么办

| 错误 | 含义 | 动作 |
|---|---|---|
| `NO_EXTENSION` | 扩展没连 | 告诉用户检查扩展，**别重试**——`chrome.alarms` 30s 心跳只能唤醒"活着但空闲"的 worker，唤不醒"脚本本身崩了"的 worker（比如改 background.js 时手滑引入语法错误），干等心跳不会自愈，等了两三个周期还是 `NO_EXTENSION` 就该直接报告、别继续空转 |
| `REF_STALE` | 编号过期 | 重新 `owb page` |
| `AMBIGUOUS_TAB` | 多个标签页都匹配 | `owb tab list` 拿 id，加 `--tab` |
| `PAUSED` | 页面停在断点 | `owb debug resume` |
| `FRAME_NOT_FOUND` | iframe 找不到 | `owb frames` 看清单；`contextId:null` 的是跨域框架，求值不了 |
| `TIMEOUT` | 页面主线程忙（最常见）/ 断点 / 模态框 | 先 `owb wait --network-idle true` 再重试，或加 `--timeout <秒>`；连 `shot` 都超时就是标签页卡死了，重试没用，`tab close` 重开 |
| `FORBIDDEN` + 提到 interstitial | Chrome 安全拦截页 | 无解，让用户在浏览器里处理证书警告 |
| 快照带 `renderNote` | 标签页没在渲染 | 已自动前台化重试；`renderNote` 会说清是内容问题还是**窗口没有系统焦点**（后者要让用户切整个浏览器窗口，不是切标签页，见下节） |

## 边界

这些操作作用在真人账号上，很多不可撤销。

**做之前必须问用户**：发消息/发帖/评论/发邮件、提交表单、下单支付、删除内容、
改账号设置、授权第三方。

**永远不做**：输入密码/验证码/支付信息（撞到就 `handoff`）、绕过人机验证、
打开与任务无关的私密页面（私信、邮箱、账单）。

读取和浏览直接做。**改变状态的操作，先说清楚要做什么，等用户点头。**

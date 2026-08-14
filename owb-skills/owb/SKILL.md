---
name: owb
description: 用 owb 命令驱动用户自己的浏览器——带着用户已登录的账号去读页面、查资料、填表、走流程、调试网站、审计适配。当任务需要「打开某个网页看看」「把这几页内容整理一下」「帮我在某站上操作」「我的网站前端出问题了」，或任何需要用户登录态/真实浏览器环境才能完成的事情时使用。
---

# owb — 驱动用户的真实浏览器

`owb` 操作的是**用户此刻正在用的那个浏览器**：他登录过的账号、他的设置、他开着的标签页。
所以你能看到只有登录后才存在的内容，也能替他完成需要身份的操作。

同样因此：**你的每一步都作用在真人的账号上**。读可以随便读，改要先问。

以下所有做法都在 **217 个真实站点、四轮完整跑动**中验证过，标 ⚠️ 的是实测踩过的坑。

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

### 慢站提速

`open` 默认等页面完全加载（所有图片、脚本）。只是要读内容的话，
`--wait-until domcontentloaded` 明显更快，实测内容不减：

| 站点 | 默认 | domcontentloaded |
|---|---|---|
| 开源中国 | 7.7s | **2.4s** |
| CSDN | 9.6s | **5.0s** |
| 新浪新闻 | 18.7s | **12.1s** |

要点后面还要交互（点按钮、等 JS 绑定）时，仍用默认或配 `owb wait`。

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

**标签页可能被别的扩展抢走**。OneTab 一类工具会把标签页整个换成自己的页面，
此时任何操作都会报 `FORBIDDEN`。**别重试**，先 `owb tab list` 看这个 tab 现在
是什么，然后用新标签页重开目标地址。

**被站点拒绝是常态**。反爬严格的站点（澎湃、知网、部分电商）会直接回 403。
`owb open` 会给出 `httpErrorHint` 点明这一点。看到它就换思路——别在空快照上
反复分析。

**空快照要看 `renderNote`**。标签页没在渲染时元素全无布局盒，工具会自动前台化
重试并说明；如果仍空，让用户切到那个标签页。

**慢站真的慢**。219 站实测导航耗时 p50 4.7 秒、p90 15 秒、p99 30 秒。
超过 30 秒基本是站点问题不是工具问题，用 `--timeout` 放宽或换 `domcontentloaded`。

**扩展偶尔会掉线，但会自愈**。Chrome 会回收 MV3 的后台脚本，扩展随后自动重连
（约 30 秒内）。你会在 stderr 看到 `[owb] 扩展暂时不可达（NO_EXTENSION），
1.5s 后重试…`——**这是正常的，命令会自己重试到成功**，不用管。只有重试耗尽
后仍失败才需要让用户检查扩展。

**有些页面根本无法检查**。Chrome 的安全拦截页（证书错误、隐私设置错误、
不安全下载警告）禁止 debugger 附着。`owb open` 会用 `attachHint` 提前告诉你，
`page` 会报 `FORBIDDEN`。**这类页面没有变通办法**——告诉用户去浏览器里看那个
标签页，证书有问题就修，或让他手动点过警告再继续。

**超时先想主线程**。`TIMEOUT` 最常见的原因不是断点，而是页面主线程被重 JS
占满（尤其还在加载时）。先 `owb wait --network-idle true` 再重试，别去找
根本不存在的断点。

## 出错怎么办

| 错误 | 含义 | 动作 |
|---|---|---|
| `NO_EXTENSION` | 扩展没连 | 告诉用户检查扩展，**别重试** |
| `REF_STALE` | 编号过期 | 重新 `owb page` |
| `AMBIGUOUS_TAB` | 多个标签页都匹配 | `owb tab list` 拿 id，加 `--tab` |
| `PAUSED` | 页面停在断点 | `owb debug resume` |
| `FRAME_NOT_FOUND` | iframe 找不到 | `owb frames` 看清单；`contextId:null` 的是跨域框架，求值不了 |
| `TIMEOUT` | 页面主线程忙（最常见）/ 断点 / 模态框 | 先 `owb wait --network-idle true` 再重试，或加 `--timeout <秒>` |
| `FORBIDDEN` + 提到 interstitial | Chrome 安全拦截页 | 无解，让用户在浏览器里处理证书警告 |
| 快照带 `renderNote` | 标签页没在渲染 | 已自动前台化重试；仍空则让用户切到该标签页 |

## 边界

这些操作作用在真人账号上，很多不可撤销。

**做之前必须问用户**：发消息/发帖/评论/发邮件、提交表单、下单支付、删除内容、
改账号设置、授权第三方。

**永远不做**：输入密码/验证码/支付信息（撞到就 `handoff`）、绕过人机验证、
打开与任务无关的私密页面（私信、邮箱、账单）。

读取和浏览直接做。**改变状态的操作，先说清楚要做什么，等用户点头。**

# 实测笔记：真实浏览器里会遇到的怪现象

这些**不是故障**，是 217 个站点、七轮跑动（累计 1521 站次）里反复撞到的客观情况。
SKILL.md「现实环境」是症状索引，**对上号了再来这里读细节**。
每条都写了根因和有没有变通办法——**标了「无解」的方向都验证过，别再试**。

## 一、Chrome 窗口不是系统前台窗口

**最高频、最容易误判成"工具坏了"的一类。** 下面三种症状根因全是它。

⚠️ 说的**不是**"标签页没激活"，而是**整个 Chrome 窗口**没有操作系统焦点
（被别的窗口挡住、用户切去别的 App）。`Page.bringToFront` 只能在窗口内切标签页，
救不了这个。

根因是 Chrome 对隐藏窗口的资源节流：`requestAnimationFrame` 不触发、媒体缓冲暂停、
合成器不产帧。**没有 CDP 层面的绕过办法**——`Emulation.setFocusEmulationEnabled`
试过，它只能把 `document.visibilityState` 骗成 `"visible"`，改不了真正的渲染节流
（实测 2048 棋盘照样不出方块）。**别再往这个方向试。**

### 诊断：两个信号都要查

```bash
owb eval 'document.visibilityState + " hasFocus=" + document.hasFocus()'
```

⚠️ **只查一个会漏判**，两个信号会往不同方向脱节，各管各的症状：

| 症状 | 跟哪个信号走 | 实测反例 |
| --- | --- | --- |
| 动画/视频/游戏卡住 | `visibilityState` | 有 `hasFocus()` 为 `true` 但 `visibilityState` 仍 `hidden`、rAF 照样不触发 |
| `shot` 卡满 30 秒 | `hasFocus()` | Flightradar24 上 `visibilityState` 是 `visible` 但 `hasFocus()` 为 `false`、合成器照样不产帧 |

**凡是"该动的没动"**（动画卡、视频不转、点了没视觉变化、连 `shot` 都超时）先跑这条，
任一个不对劲就**提醒用户把整个浏览器窗口切到系统前台**，别反复重试。

### 症状 A：动画 / 视频 / 游戏不动

实测：YouTube `<video>` 卡在 `readyState:0`；play2048.co 棋盘一个方块都不生成、
按方向键无反应。**后者是因果关系的反证**——同一窗口自己变回前台后（真实环境里
窗口焦点本来就会变），同一页面重开立刻正常出方块、按键正常。

### 症状 B：`shot` 卡满 30 秒 → 先补一条 `owb eval "1+1"` 分叉

截图走合成器帧捕获、不需要 JS 参与，所以 `eval` 能不能回是关键分水岭：

- **`eval` 也超时** → 渲染进程真卡死了，不是"脚本正忙"。实测 Google 表格：
  `open` 到别的网址不生效、`eval`/`shot` 双双超时，几分钟后依旧，`debug resume`
  也没用（报 `NOT_PAUSED`）。**处置：`tab close` 关掉，新标签页重开**，立刻恢复。
- **`eval` 秒回、只有 `shot` 卡** → 标签页没坏，是窗口没焦点。
  `Page.captureScreenshot` 在等一帧合成好的画面，等不到就是 30 秒硬超时，
  **跟页面是不是 WebGL 无关**（普通 IMDB 页面一样卡）。
  ⚠️ **这种情况 `tab close` 是白做**——新标签页一样没有系统焦点。

### 症状 C：快照为空带 `renderNote` / 正文读成 0 字

标签页没在渲染时元素没有布局盒，快照为空；工具会**自动前台化重试**，
`renderNote` 会说清是内容问题还是窗口焦点问题。

正文类还有一种：滚动淡入动画在窗口无焦点时永远不触发，`innerText` 读成空
（实测 claude.com 博客 `article` 模式只有 3 字，DOM 里其实有 2.8 万字）。
**`--mode text` 会自动回退到 `textContent` 把正文捞出来**，并标
`textSource: "textContent-fallback"`——回退文本是 DOM 顺序、会混进导航，
当正文读没问题，别拿它判断布局。

## 二、拖拽 / 画布：完整三段式模板

`click` / `click-mouse` 都是"落点即抬"，模拟不了拖拽。

⚠️ **先试两次 `click-mouse`**（点起点、点终点），比三段式简单得多。实测
chess.com 棋盘这样就够了，走法正确记谱。确认站点**不**支持点选（选中后目标格
没高亮、点了没反应）再升级。

真需要拖拽时 `owb cdp` 直发三条，实测 Excalidraw 画矩形一次成功：

```bash
owb cdp --args '{"method":"Input.dispatchMouseEvent","params":
  {"type":"mousePressed","x":300,"y":250,"button":"left","buttons":1,"clickCount":1}}'
owb cdp --args '{"method":"Input.dispatchMouseEvent","params":
  {"type":"mouseMoved","x":500,"y":400,"button":"left","buttons":1}}'
owb cdp --args '{"method":"Input.dispatchMouseEvent","params":
  {"type":"mouseReleased","x":500,"y":400,"button":"left","buttons":0,"clickCount":1}}'
```

- ⚠️ 中间的 `mouseMoved` **必须带 `buttons:1`**（左键仍按住）。漏了就是"光标动了、
  元素纹丝不动"——很多拖拽实现靠这个字段判断是否在拖。
- canvas 内容不是 DOM，`owb page` 什么都看不到，只能 `owb shot` 确认。
- **地图类**（Google 地图等 WebGL 瓦片图）同样可用来平移，多给几个中间
  `mouseMoved` 点让轨迹连续。⚠️ 但松手那一点若落在带标签的兴趣点上，地图会
  同时判定成"点击"并弹信息卡——**让终点落在空白区域**（水面、空地）。

## 三、页面上有别的扩展的东西

- **注入的浮层按钮**：快照会剔除已知框架（Plasmo/CRXJS）挂载的元素并记进
  `extensionUiHidden`，但**剔不干净**（注入方式五花八门，很多划词/悬停才出现）。
  自己认：`图片翻译`、`快捷设置`、`添加到收藏夹` 这类**与页面主题毫无关系**的
  按钮基本都是别的扩展的，**别去点**。判据就一句：它和你在做的事有关系吗？
- **整个标签页被抢走**：OneTab 一类工具会把标签页换成自己的页面，此后任何操作都报
  `FORBIDDEN`（实测淘宝、东方财富反复出现）。**别重试**，`owb tab list` 确认，
  新标签页重开。

## 四、读不到内容的几种情况

| 情况 | 表现 | 处置 |
| --- | --- | --- |
| **反爬拒绝** | 403 或空壳页，`open` 给 `httpErrorHint`（澎湃、知网、部分电商） | **换思路**，别在空快照上反复分析 |
| **Chrome 安全拦截页** | 证书/隐私错误页禁止 debugger 附着，`open` 给 `attachHint`，`page` 报 `FORBIDDEN` | **无解**，让用户在浏览器里处理 |
| **Chrome 结构性禁调试地址** | Web Store、`chrome://`、`devtools://`、别家扩展页；`open` 成功、之后全 `FORBIDDEN` | **无解**，换信息源 |
| **PDF 网址** | 三种模式都读不出正文 | 见下 |

**PDF**：Chrome 内置阅读器渲染在**独立沙盒视图**里，DOM 和无障碍树都看不进去
（`Accessibility.getFullAXTree` 也查过）——**不是选择器没写对，是架构上够不到**。
变通：找 HTML 版本（arXiv 详情页通常有「HTML (experimental)」链接，跳过去
`--mode article` 正常读）。没有 HTML 版的只能 `owb shot` 截图，或让用户自己看。

**诱饵文本**：eBay 搜索页 `text` 模式出现过 `derosnopS`（倒读 "Sponsored"），
是专门放给爬虫的诱饵（`color: transparent` + `aria-hidden="true"`，人眼看不到）。
遇到这种明显不成词的短串**当噪音跳过**。

## 五、⚠️ Google Docs 的 `/create` 地址：导航即副作用

**光是导航过去就会在用户真实账号里建一个文件。** `docs.google.com/document/create`、
`.../spreadsheets/create`、`.../forms/create` 不是"打开创建页等你确认"——
访问 URL 本身就落下一个持久化的空白文档。

实测踩过两次（Sheets、Forms），且新建的空白文件**"移到回收站"是禁用的**：
Google 对完全没编辑过的全新文档就是这个行为，手动点也删不掉，得先有过一次内容变更。

**任务不是真要新建文档，就别导航到这类地址。** 已经手滑创建了，别在禁用的删除按钮上
反复试，如实告诉用户账号里多了个空文件。

## 六、扩展掉线：会自愈，但只限一种情况

Chrome 会回收 MV3 的 service worker，扩展随后自动重连。stderr 会出现：

```
[owb] 扩展暂时不可达（NO_EXTENSION），1.5s 后重试…
```

退避 1.5s→4s→10s→20s，累计约 35 秒。**这是正常的，命令会自己重试到成功。**
（中转模式退避上限放宽到 60 秒，见 `relay.md`。明知浏览器没开着不想干等，
设 `OWB_NO_EXT_RETRY=1` 跳过退避。）

⚠️ **自愈只对"活着但空闲被回收"有效，对"脚本本身崩了"完全无效。**
`chrome.alarms` 心跳唤不醒"顶层解析就报错"的 worker（比如刚改坏了 background.js
又 `reload-ext` 加载了进去）——心跳每次醒来执行的还是同一份坏脚本，**干等多久都
不会变**。**一轮退避跑完仍 `NO_EXTENSION`，就是停下来报告用户的信号。**

## 七、超时：先想主线程，再想站点

`TIMEOUT` 最常见的原因是**页面主线程被重 JS 占满**（尤其还在加载时），
不是断点。先 `owb wait --network-idle true` 再重试。
（例外：`shot` 超时是另一条路，见第一节症状 B。）

导航本身也真的慢——219 站实测 **p50 4.7s / p90 15s / p99 30s**。
超过 30 秒基本是站点问题，用 `--timeout-ms` 放宽（⚠️ 不是 `--timeout`，
见 SKILL.md「三层超时」）或换 `--wait-until domcontentloaded`。

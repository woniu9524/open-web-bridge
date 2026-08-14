# 实战案例

在 **217 个真实站点、四轮完整跑动**中验证出来的工作流。每条都是真跑过的命令与
真实产出，不是构想；所有数据都在修复完成后复测过。

---

## 1. 学术情报流水线：今天的论文，哪些真的开源了？

**问题**：arXiv 每天 200+ 篇 AI 论文，标题都说"我们开源了"。哪些真有代码、仓库活不活跃？

**AI 做的事**（三个网站串联）：

```bash
owb open https://arxiv.org/list/cs.AI/recent
owb eval '<提取当日论文 id + 标题>'          # 结构化拿到列表
owb open https://arxiv.org/abs/2608.13476    # 逐篇进详情
owb eval '<抓摘要 + 页面里的代码链接>'
owb open https://github.com/Penn-RAIL/MARC-v1 # 去仓库核实
owb eval '<读 star / fork / 最近提交时间>'
```

**真实产出**：

| 论文 | 摘要要点 | 代码 | 仓库活跃度 |
|---|---|---|---|
| MARC v1（临床 AI 多智能体） | 用确定性多智能体编排替代单体 LLM 提示 | github.com/Penn-RAIL/MARC-v1 | ★2 / fork 2 / 3 天前提交 |
| OmniScientist | 全模态全学科 AI 科学家 | omni-scientist.github.io | 项目主页，未见仓库 |
| AlayaWorld | 长时程世界建模 | 仅 HuggingFace 泛链接 | 无独立仓库 |

一眼看出：三篇里只有一篇给了可核实的活跃仓库，且非常新（★2）——这是"值不值得跟进"
的判断依据，而这个判断**必须跨三个网站才能做出来**。

---

## 2. 响应式适配审计：发现主流网站的真实布局问题

**AI 做的事**：同一页面切三档视口，每档自动截图 + 量化检查。

```bash
owb env set --width 390 --height 844 --mobile true --touch true
owb shot --out mobile.png
owb eval '<检查横向溢出 / 小于12px的字 / 高度不足24px的点击区>'
owb env reset
```

**真实发现**：

| 站点 | 桌面 1280px | 手机 390px |
|---|---|---|
| anthropic.com | 无溢出，无小字 | 无溢出，无小字 ✅ |
| 新浪新闻 | 无溢出 | ⚠ **横向溢出，内容宽 1000px**（手机上必须左右拖动） |
| 当当网 | 79 个点击区高度 < 24px | `innerWidth` 仍是 1200px —— **站点根本没有响应式 viewport** |

截图同时落盘，可以直接贴进缺陷报告。

---

## 3. 网站性能体检：一条命令回答「哪个请求最慢」

**AI 做的事**：

```bash
owb net start                       # ← 必须在导航之前
owb open https://目标站/
owb net list --sort-by duration --limit 10   # 最慢的十个
owb net list --sort-by size --limit 10       # 最占带宽的十个
owb debug console                            # 页面报错
```

**真实产出**（CSDN 首页）：187 个有效请求，其中 **142 个是图片**（76%），
5 个请求失败。请求构成一目了然：

```
Document 8 | Script 16 | Stylesheet 6 | Image 142 | XHR 13 | Font 1
```

"图片占请求数四分之三"就是首屏优化的第一条结论。

---

## 4. 增量快照：只读变化，不重读整页

**为什么重要**：传统做法是操作后重新读整页，几千 token 里可能只有几十个字变了。

**AI 做的事**（HuggingFace 搜索模型）：

```bash
owb fill @e86 "qwen3"
owb wait --network-idle true
owb page --since-last true
```

**真实产出**：
```
added=54  changed=6  removed=62  unchanged=340
```

只有 54 条新增内容进入 AI 的上下文，而不是整页 400 个元素。搜索结果的变化被
精确切出来——这是长会话里能撑住的关键。

---

## 5. 真·点击导航：AI 像人一样操作页面

不是靠拼 URL，是真的填框、点按钮、等跳转。

```bash
owb open https://en.wikipedia.org/wiki/Main_Page
owb page                              # 找到 @e17 搜索框、@e18 搜索按钮
owb fill @e17 "Model Context Protocol"
owb click @e18
owb wait --url-pattern "Model"        # 等跳转落地
owb page --mode article               # 读到正文
```

**真实产出**：759ms 后到达 `en.wikipedia.org/wiki/Model_Context_Protocol`，
正文提取 11318 字符。

值得注意的一处细节：`click` 返回了 `navigated: false` 并附
`_hint: "the click dispatched but the page didn't navigate yet"`——
**工具对不确定的事如实说不确定**，AI 因此知道要 `wait` 而不是直接读页面。
这种诚实是 AI 能自我恢复的前提。

## 6. 状态变更的精确捕捉

点一个单选框，AI 收到的是：

```
added=0  changed=1  removed=0
@e168 radio "CSS" checked
```

页面上几百个元素，只有这一行进入上下文。不需要重读整页去猜"刚才那下生效了吗"。

## 7. 从实时地图里取数据

USGS 全球地震实时图（WebGL 渲染 + 动态列表）：

```bash
owb open "https://earthquake.usgs.gov/earthquakes/map/"
owb eval '<提取事件列表>'
```

**真实产出**（当次抓取）：

```
M4.8  207 km SE of Katsuura, Japan     深 10.0km
M4.2  35 km WSW of Neyshābūr, Iran     深 10.0km
M2.7  4 km S of Petrolia, CA           深 10.3km
统计: 最大 M4.8 | 平均 M3.20 | 样本 12 条
```

数据是此刻的，不是缓存的数据集——因为它就是从用户屏幕上那个页面里取的。

## 8. 人机交接：撞到验证码不是终点

**场景**：帮用户在 npm 注册账号并发布包。注册需要邮箱验证 + 一次性密码。

**AI 做的事**：

```bash
owb open https://www.npmjs.com/
owb page                             # 读到页面只有 Sign Up / Sign In → 未登录
owb open https://www.npmjs.com/signup
owb handoff --reason "请在这个页面注册账号，完成后告诉我"
# ——用户接手，输入密码、过 OTP——
owb page                             # 读到 Profile menu + 头像 → 确认登录成功
```

**真实产出**：AI 从页面结构判断出未登录状态，把浏览器交还用户并说明要做什么，
用户完成后 AI 自己确认登录态、继续后续工作。**凭据全程不经过 AI**。

---

## 9. 性能体检：一条命令找出最占带宽的资源

```bash
owb net start
owb open https://www.bbc.com/news
owb net list --sort-by size --limit 3
```

**真实产出**（BBC 新闻首页）：

```
168KB  1136ms  cdn.permutive.com/…          ← 第三方追踪脚本，比页面本身还大
 63KB  1317ms  www.bbc.com/news             ← HTML 文档
 53KB  1663ms  ichef.bbci.co.uk/ace/…       ← 首屏图片
```

一眼看出：**一个第三方追踪脚本比 HTML 文档本身大 2.7 倍**。这就是优化的第一刀。

## 可靠性：四轮 217 站跑下来是什么样

| 轮次 | 哑 ref 率 | 正文提取成功 | 硬失败 |
|---|---|---|---|
| 第 1 轮（修复前） | 15.7% | 35% | 3 / 219 |
| 第 2 轮（修复后） | 5.0% | 65% | 4 / 217 |
| 第 3 轮（+ 掉线重试） | 6.5% | 66% | 3 / 217 |

**剩余失败全部是环境与站点的客观限制，不是工具缺陷**，且每一条都已变成
AI 能理解并处置的信息：

- 反爬站点直接回 403 → `httpErrorHint` 点明「被拒了」
- 证书错误的站点触发 Chrome 安全拦截页 → `attachHint` 说明「这页无法检查」
- 标签管理类扩展（OneTab）抢走标签页 → 错误信息告诉 AI 去 `tab list` 查看
- 重 JS 站点主线程饱和 → 超时提示首推「先等网络空闲」

## 这些为什么传统自动化做不到

| | 传统无头浏览器 | owb |
|---|---|---|
| 登录态 | 要么脚本模拟登录（易触发风控），要么维护 cookie 池 | **直接用你已经登录好的浏览器** |
| 指纹 | 干净环境，处处像机器人 | 你的真实浏览器、真实指纹 |
| 撞验证码 | 流程中断，脚本失败 | `handoff` 交回你，弄完 AI 自动接管 |
| 你能看到吗 | 后台跑，出了事才知道 | 就在你眼前的窗口里，随时能接管 |

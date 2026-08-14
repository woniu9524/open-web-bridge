---
name: owb
description: 用 owb 命令驱动用户自己的浏览器——带着用户已登录的账号去读页面、查资料、填表、走流程、调试网站。当任务需要「打开某个网页看看」「把这几页内容整理一下」「帮我在某站上操作」「我的网站前端出问题了」，或任何需要用户登录态/真实浏览器环境才能完成的事情时使用。
---

# owb — 驱动用户的真实浏览器

`owb` 让你操作**用户自己正在用的那个浏览器**：他登录过的账号、他的设置、他打开着的标签页。
所以你能看到只有登录后才能看到的内容，能替他完成需要身份的操作。

这也意味着：**你的每一步都作用在真人的账号上**。当心。

## 开始之前：先自检

```bash
owb
```

- `✓ daemon` + `✓ 扩展已连接` → 可以开始
- `✗ 扩展未连接` → 停下来告诉用户：点浏览器工具栏的扩展图标看状态。别硬调工具，会一直报 `NO_EXTENSION`
- 命令找不到 → 用户可能没装：`npm i -g open-web-bridge`，然后 `owb setup`

## 核心循环：看 → 指 → 动

owb 不需要你猜 CSS 选择器。`owb page` 会把当前页面变成一份带编号的清单，
每个可交互元素有个 `@eN` 编号，你直接用编号操作。

```bash
owb open https://example.com     # 打开
owb page                          # 看：得到 @e1 @e2 … 和页面结构
owb fill @e3 "关键词"             # 指 + 动
owb click @e5
owb wait --text "搜索结果"        # 等页面就绪，别用 sleep
owb page --mode article           # 正文提取成 markdown，适合读长文
```

几条要紧的：

- **编号会过期**。页面跳转或重渲染后旧编号失效（报 `REF_STALE`），重新 `owb page` 拿新的。
- **等待用 `owb wait`**，别写循环 `eval` 轮询——`wait` 支持 `--selector` / `--text` /
  `--url-pattern` / `--network-idle`。
- **读长文用 `--mode article`**，比整页快照省一大截 token；连续读同一页用 `--since-last` 只拿变化。
- 也可以用 CSS 选择器：不以 `@` 开头就按选择器处理，如 `owb click ".submit"`。

## 常见任务怎么做

### 读需要登录才能看的内容

用户的登录态就在浏览器里，直接开就行。

```bash
owb open https://www.zhihu.com/question/12345
owb page --mode article          # 正文 → markdown
```

多页收集时，先 `owb page` 找到下一页的编号，点进去再读，循环。

### 把散落在几个页面的信息汇总

```bash
owb open <页面1> && owb page --mode article
owb open <页面2> && owb page --mode article
```

读完在你这边合并成用户要的形式（表格、摘要、对比）。不用把中间结果写进文件，
除非用户要留档。

### 帮用户填表 / 走流程

```bash
owb page                          # 先看清表单有哪些字段
owb fill @e2 "张三"
owb fill @e3 "13800138000"
owb page                          # 提交前再看一眼，确认填对了
```

**提交前必须停下来问用户**——见下面「边界」。

### 调试用户自己的网站

前端排查时，你能看到浏览器里真实发生了什么：

```bash
owb net start                     # 开始记录网络
owb open http://localhost:3000
owb click @e4                     # 触发那个出问题的操作
owb net list                      # 看请求都发了什么、返回什么
owb net detail --id <请求id>      # 单条请求的完整头和 body
owb debug console                 # 页面 console 输出（报错在这）
```

慢的问题看 `owb net list` 的耗时；想留证据给同事看，用
`owb har start` / `owb har stop` / `owb har save` 存成标准 HAR 文件。

### 测移动端 / 弱网 / 其他地区

```bash
owb env set --width 390 --height 844 --mobile true --touch true   # 手机视口
owb env set --args '{"network":{"latency":300,"download":400000,"upload":400000}}'  # 弱网
owb env set --args '{"geolocation":{"latitude":31.23,"longitude":121.47}}'          # 定位
owb env reset                                                      # 用完务必恢复
```

视口用扁平参数就行；`network`/`geolocation` 是对象，走 `--args`。改完记得
`owb env reset`，否则用户的浏览器会一直停在模拟状态。

### 撞到验证码、要扫码登录

不要试图绕过。把控制权交回用户：

```bash
owb handoff                       # 把标签页交还用户，并告诉他要做什么
owb wait-user                     # 等他弄完，你自动接管继续
```

然后**明确告诉用户你需要他做什么**（"请在浏览器里完成扫码，好了我继续"）。

### 保存登录态备用

```bash
owb state save 某站                # cookie + localStorage + IndexedDB
owb state load 某站                # 换机器/换 profile 后恢复
```

### 把跑通的流程固化下来

同样的流程要重复跑（每周导报表之类）：

```bash
owb flow save 周报                 # 把刚才这串操作存成工作流
owb flow run 周报                  # 以后一条命令重放
```

## 命令速查

`owb help` 看全部，`owb help <组>` 看某组详情。

| 组 | 干什么 | 常用 |
|---|---|---|
| 基础 | 导航、看页面、操作 | `open` `page` `click` `fill` `keys` `wait` `eval` `shot` |
| tab | 多标签 | `tab list` `tab find` `tab close` |
| net | 网络请求 | `net start` `net list` `net detail` |
| har | 录成 HAR 存档 | `har start` `har stop` `har save` |
| state | 登录态存取 | `state save` `state load` |
| env | 设备/网络/地区模拟 | `env set` `env reset` |
| flow | 工作流固化 | `flow save` `flow run` |
| human | 交回人类 | `handoff` `wait-user` |
| debug | 页面调试 | `debug console` `debug break-xhr` `hook preset` |

## 参数写法

- `--foo-bar 值` → 工具参数 `foo_bar`；能当 JSON 解析就解析（`--new-tab true`），否则当字符串
- `--tab <id>` 指定标签页（不给就用当前活动的）
- `--timeout <秒>` 放宽超时（截图、慢站导航可能要）
- `--args '<json>'` 传别名没覆盖到的冷门参数
- 逃生口：`owb call <底层工具名> --args '<json>'`

## 出错了怎么办

失败时 stderr 会有一行 `error CODE: message`，退出码非 0。常见的：

| 错误 | 意思 | 怎么办 |
|---|---|---|
| `NO_EXTENSION` | 扩展没连上 | 告诉用户点扩展图标检查，别重试 |
| `REF_STALE` | 元素编号过期 | 重新 `owb page` |
| `AMBIGUOUS_TAB` | 多个标签页都匹配 | 用 `owb tab list` 找到 id，加 `--tab <id>` |
| `PAUSED` | 页面停在断点上 | `owb debug resume` |
| `TIMEOUT` | 超时 | 页面可能还在加载，先 `owb wait`，或加 `--timeout` |

## 边界

这些操作作用在真人的账号上，很多不可撤销。

**做之前必须先问用户**：
- 发送任何东西——发消息、发帖、评论、发邮件
- 提交表单、下单、支付、确认
- 删除任何内容
- 修改账号设置、授权第三方

**永远不做**：
- 输入密码、验证码、支付信息——撞到就 `owb handoff` 交给用户
- 绕过人机验证
- 打开与任务无关的页面，尤其是用户的私信、邮箱、账单

读取和浏览可以直接做。**改变状态的操作，先说清楚你要做什么，等用户点头。**

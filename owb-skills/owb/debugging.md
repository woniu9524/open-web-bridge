# owb 调试与逆向线

SKILL.md 讲怎么用浏览器**干活**，这份讲怎么用它**查问题**：
接口为什么慢、请求为什么 403、这个签名参数是谁算的、改版有没有破坏老接口。

五级台阶，**从上往下用，能在上一级解决就别下沉**：

| 台阶            | 命令                                | 回答什么问题                |
| ------------- | --------------------------------- | --------------------- |
| ① 看请求         | `net start/list/detail/initiator` | 发了什么、多慢、多大、谁发起的       |
| ② 存证据         | `har start/save` + `to-replay/diff/assert` | 留档、转成脱离浏览器的重放脚本、回归比对  |
| ③ 挂钩子         | `hook preset/fn` + `hook logs`    | 某个函数被调了几次、入参出参是什么     |
| ④ 下断点         | `debug break-xhr/break-fn/frames` | 请求发出的**那一刻**，闭包里有什么变量 |
| ⑤ 读/改代码       | `script search/source/patch`、`oracle`、`verify signer` | 算法本身长什么样、能不能脱离页面复现    |

## ① 看请求

⚠️ **`net start` 必须在导航之前**，否则拿到的是一批没有 URL 的孤儿记录
（返回里 `orphanRecordsHidden` 会告诉你丢了多少条）。

```bash
owb net start                                  # 默认清空旧 buffer（--clear false 保留）
owb open https://目标站 --new-tab true
owb net list --sort-by duration --limit 10     # 最慢的十个
owb net list --sort-by size --limit 10         # 最占带宽的十个
owb net list --url-pattern "api/"              # 只看接口
owb net detail --request-id <id> --include-body true   # 单条完整头 + body
owb net initiator --request-id <id>            # 谁发起的：完整调用栈
```

`net initiator` 是从「这个请求哪来的」跳到「哪段代码发的」的桥——拿到栈顶的
脚本 URL + 行号，直接接第 ⑤ 级 `script source` 去读那段代码。

**要抓一个"点了才发"的请求**，别自己 race，用宏工具一步到位：

```bash
owb net capture --url-pattern "api/search" --args '{"trigger":"document.querySelector(\"#go\").click()"}'
```

它先布好监听再执行 `trigger`，然后返回匹配到的那条请求。

## ② HAR：留档、转脚本、回归比对

```bash
owb har start --args '{"include_bodies":true,"url_pattern":"api/"}'
owb open <目标页> --new-tab true
owb har save --args '{"filename":"排查记录"}'
```

⚠️ **不要 `har stop` 再 `har save`**：`save` 内部已含 stop，先手动 stop 会销毁
录制器，`save` 报 `NOT_RECORDING` 且**数据永久丢失**。
⚠️ 有活动任务时固定落 `tasks/<任务 id>/recording.har`，`filename` 被忽略。

录下来之后三件事，这才是 HAR 的价值所在：

```bash
# 转成脱离浏览器的重放脚本（动态签名头会标成占位符）
owb har to-replay --path har/排查记录.har --format python --save true

# 改版前后两份 HAR 比漂移：少了哪个请求、状态码变了、响应结构变了
owb har diff --baseline har/上线前.har --current har/上线后.har --save true

# 断言校验：把"这个接口必须 200、必须包含这个字段"变成可重复跑的检查
owb har assert --path har/排查记录.har --args '{"assertions":[
  {"type":"request_exists","url_pattern":"api/user"},
  {"type":"response_status","url_pattern":"api/user","value":200},
  {"type":"response_contains","url_pattern":"api/user","value":"nickname"},
  {"type":"min_requests","value":5}
]}'
```

断言类型：`request_exists` / `request_absent` / `response_status` /
`response_contains` / `min_requests`。⚠️ `har` 参数传 JSON **字符串**会被自动
解析回对象；传不合法的 JSON 会明确报 `BAD_HAR`，不会静默"断言全过"。

## ③ 钩子：看某个函数被怎么调的

三个现成预设，覆盖绝大多数"参数是怎么拼出来的"场景：

| 预设       | 钩住什么                             |
| -------- | -------------------------------- |
| `xhr`    | `XMLHttpRequest` 的 open/send/setRequestHeader |
| `fetch`  | `fetch()` 的入参与响应                 |
| `crypto` | `btoa`/`atob`/`JSON.stringify` 这类编解码原语 |

```bash
owb hook preset crypto            # ⚠️ 默认会刷新页面（见下）
owb click @e5                     # 触发目标操作
owb hook logs --source hook:crypto --limit 50
```

⚠️ **`hook preset` 的 `reload` 默认为 true，会把页面刷掉**——钩子靠
`addScriptToEvaluateOnNewDocument` 注入，只对**注册之后创建的文档**生效，不刷新
根本不起作用。代价是表单填了一半、未保存的页面状态全没。要保住现场就传
`--reload false`，但那样**当前页面上钩子不生效**，得等下一次导航（返回里的
`_hint` 会明说这一点，别忽略它）。

**钩任意函数**（页面自己的全局函数，比如 `app.sign`）：

```bash
owb hook fn --function-path "app.sign" --trace-args true --trace-ret true --trace-stack true
owb click @e5
owb hook logs --source hook:fn
```

`--position before|after|replace`，`replace` 配 `--replacement '<函数表达式>'`
可以整个换掉实现；`--hook-code` 传自定义回调 `(args, result, stack) => {...}`；
`--non-overridable true` 防止页面 SDK 后续把你的钩子覆盖掉。
目标函数注入时还不存在也没关系，模板会轮询等它出现（最多 15 秒）。

⚠️ **`hook logs` 的返回字段叫 `events`，不是 `logs`**；`--since-seq` 增量拉取
（写成 `--since` 也认）；多 tab 同时挂钩子时用 `--tab` 过滤，否则事件是混的
（返回里 `filtered_other_tabs` 会告诉你滤掉了多少）。
⚠️ `crypto` 预设在复杂站点上每秒可能命中上千次 `JSON.stringify`，
用 `--source` + `--limit` 收窄，别一次拉全量。

## ④ 断点：冻在请求发出的那一刻

钩子看得到入参出参，看不到**闭包里的中间变量**。要看那些就下断点。

```bash
owb debug break-xhr --url-substring "/api/sign"    # XHR 断点
# 或：owb debug break-fn --function-path "app.sign"
owb click @e5                                      # 触发
owb debug frames --max-frames 3 --prop-limit 40    # 读冻结现场的调用帧与作用域
owb debug resume                                   # 放行
```

- `debug frames` **默认不自动放行**（要显式 `--auto-resume true`），因为自动
  resume 会打断你连续检查同一个断点。读完记得 `debug resume`，否则页面一直停着，
  后续任何操作都报 `PAUSED`。
- 没断住就调 `frames` 会报 `NOT_PAUSED`，错误消息会告诉你断点armed 了没有、
  是不是还没触发到那段代码——**那不是瞬时故障，别空转重试**，去触发代码路径。
- `debug step --action into|over|out` 单步；`debug break-remove` 拆断点。
- 页面报错本身用 `owb debug console --enabled true` 收 console 流。

⚠️ 断点会**冻住整个页面**。用户如果正在旁边看这个标签页，他会看到页面卡死。
调试完务必 `resume` + `break-remove`。

## ⑤ 读代码、验算法

**找代码**：

```bash
owb script list --url-pattern "app"              # 页面加载了哪些脚本
owb script search --query "sign" --limit 20      # 全脚本源码搜索（--is-regex true 用正则）
owb script source --script-id <id> --max-chars 20000
```

`script search` 是逆向的主入口——比在 devtools 里翻文件快得多。配合第 ①
级 `net initiator` 拿到的栈顶脚本 URL + 行号，能直接定位到发请求的那几行。

**改代码**（下次加载生效）：

```bash
owb script patch --url-pattern "app\\.js" --code '<要插入的 JS>' --patch-type prepend
owb script watch --url-pattern "app\\.js"        # 监听这个脚本何时被加载
owb script unpatch --url-pattern "app\\.js"      # 用完撤销
```

⚠️ `script patch` 改的是**用户真实浏览器里这个站点的行为**，只在当前会话有效，
但用完请 `unpatch`，别留着。

**确定性采样调用**（`oracle`）——不猜实现，直接拿页面里那个函数当黑盒跑：

```bash
owb oracle --function-path "app.sign" --args '{"call_args":["hello",123]}'
```

`--freeze` 默认 true（调用期间冻结时间/随机源，保证同输入同输出）。
也可以用 `--object-id`（`debug frames` 里拿到的闭包函数引用）调闭包里的私有函数。
⚠️ **参数名写错会直接报错**，不会像以前那样静默无参调用返回一个假成功的 null。

**离线验签**——把你猜出来的算法跟真实样本对拍：

```bash
owb verify signer --args '{
  "source": "(input) => ({ sig: myHash(input.a + input.b) })",
  "samples": [{"input":{"a":"1","b":"2"},"expected":{"sig":"abc123"}}]
}'
```

⚠️ **`source` 必须求值成一个函数**——裸的 `function f(){}` 声明求值为
`undefined`，要用括号包起来。只给 `calls` 不给 `expected` 会走 dry-run
（把算出来的值交回给你，不伪造 pass_rate）。全部样本对拍失败会明确报
`VERIFY_FAILED`，并在 `results[].first_divergence` 指出第几个字节开始不一样。

**TLS 指纹重放**——验证这个请求能不能脱离浏览器复现：

```bash
owb verify replay --url "https://x.com/api/sign" --method POST \
  --impersonate chrome --args '{"headers":{...},"body":"..."}'
```

需要 `curl-impersonate` 二进制（`<repo>/bin/`、PATH、或 `OWB_CURL_BINARY`
指定；找不到会给下载地址）。`--impersonate` 可用 `chrome|edge|firefox|safari`
别名或带版本号的具体目标。

**取证留档**：`owb verify evidence --path <work 下相对路径> --args '{"content":...}'`
把结论写进归档目录，跟 HAR、任务记录放一起。

## 串起来：一次典型的"这个参数怎么来的"

```bash
owb task begin "查 sign 参数"
owb net start
owb open https://目标站 --new-tab true
owb click @e5                                   # 触发那个请求
owb net list --url-pattern "api/" --limit 5     # ① 找到它
owb net initiator --request-id <id>             # ① 谁发的 → 拿到脚本 + 行号
owb script search --query "sign="               # ⑤ 搜到候选实现
owb hook fn --function-path "app.sign" --trace-args true --trace-ret true
owb click @e5                                   # ③ 再触发一次，看真实入参出参
owb hook logs --source hook:fn
owb oracle --function-path "app.sign" --args '{"call_args":["<刚看到的入参>"]}'   # ⑤ 黑盒对拍
owb verify signer --args '{"source":"<你复现的实现>","samples":[...]}'            # ⑤ 离线验证
owb har save --args '{"filename":"sign-调查"}'
owb task end && owb tab close-group
```

每一级都可能提前结束——`net detail` 就看出是后端返回变了，就不用往下走。

## 这条线上的通用坑

- **钩子和断点都作用在用户真实的浏览器上**。页面会被刷新、会被冻住，用户在旁边
  是看得见的。开始前说一声，结束后 `hook remove` / `break-remove` / `script unpatch`
  收干净。
- **`--url-pattern` 是正则不是通配符**，`app.js` 里的点要转义成 `app\\.js`
  （shell 里还要多一层）。
- **改完扩展代码用 `owb reload-ext`**，不用手点 chrome://extensions。但如果改出了
  语法错误，扩展会彻底起不来（`NO_EXTENSION` 且心跳唤不醒）——那时只能去浏览器里
  看扩展的报错。
- 逆向类操作只用于**用户自己的站点、或用户明确授权排查的站点**。绕过风控、
  破解他人系统不做。

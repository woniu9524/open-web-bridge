# owb 命令参数速查

SKILL.md 讲怎么干活，这份讲**每条命令收什么参数**。写复杂调用前查一下，
比试错快。`owb help <组名>` 是同一份信息的命令行版（更短）。

## 通用规则

- `--foo-bar 值` → 工具参数 `foo_bar`；值能 JSON 解析就解析（`--new-tab true`
  是布尔 true，不是字符串）
- `--tab <id>` → `tabId`；不给就用**当前活动标签页**
- `--args '<json>'` 整体合并，**优先级最高**；对象类参数（`network`、
  `geolocation`、`files`、`assertions`）只能这样传
- `--out <路径>` 只对截图/PDF 有意义（二进制落盘）
- `--raw` 输出完整 result 信封、`--compact` 单行 JSON、`--no-autostart` 不自动拉 daemon
- 点击类命令的 `selector` 和 `ref` **二选一**，给两个报 `BAD_ARGS`；
  位置参数以 `@` 开头当 ref，否则当 CSS selector

### 超时（三层，见 SKILL.md）

| 层             | 参数                  | 默认                                            |
| ------------- | ------------------- | --------------------------------------------- |
| CLI 等 ctl 结果  | `--timeout <秒>`     | 120（ctl 侧上限 300）                              |
| 工具内部等待        | `--timeout-ms <毫秒>` | open 30000 / wait 10000（上限 110000）/ wait-user 280000 |
| 单条 CDP 调用     | —                   | 30 秒硬编码，**改不了**                               |

`--timeout` **不会**传给工具。放宽页面等待一律用 `--timeout-ms`。

## 元命令

| 命令                            | 说明                                     |
| ----------------------------- | -------------------------------------- |
| `owb`                         | 自检：daemon 可达性、模式（local/relay）、扩展连接、attached tabs |
| `owb setup`                   | 安装引导（扩展路径 + 装 skill + 自检）              |
| `owb skill install [--project]` | 装 skill 到 `~/.claude/skills/owb`（或当前项目） |
| `owb skill path`              | 打印包内 skill 源目录                         |
| `owb help [组名]`               | 全部命令 / 组内详情                            |
| `owb call <底层工具名> --args '<json>'` | 直调任意底层工具（别名没覆盖的走这里）                    |

## 基础

| 命令                | 参数                                                                            | 备注                                                              |
| ----------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `open <url>`      | `url`(必) `--new-tab` `--active`(默认 true) `--wait-until load\|domcontentloaded\|complete` `--timeout-ms`(30000) | 超时不报错，返回 `loadCompleted:false`；另可能带 `httpErrorHint`/`attachHint`/`taskHint` |
| `back` / `forward` | `--timeout-ms`                                                                | 底层 `history`                                                     |
| `reload`          | `--bypass-cache` `--timeout-ms`                                               | 强刷用 `--bypass-cache true`                                        |
| `page`            | `--mode snapshot\|article\|text`(默认 snapshot) `--max-chars`(20000，最小 100) `--max-nodes`(400，**最大 2000**) `--since-last` | 返回 `lines`/`content`/`text` + 恒有 `text` 别名；截断时给 `truncated`/`omittedNodes` |
| `shot`            | `--format png\|jpeg`(png) `--quality`(jpeg 时 1-100，默认 80) `--full-page` `--out <路径>` | 自动落盘，stdout 只回 `{savedTo, bytes}`                                |
| `click <@ref\|selector>` | `--ref` / `--selector` 二选一，`--mouse true` 直接换 `click-mouse`                    | disabled 元素会明确报错，不会假成功                                           |
| `click-mouse <@ref\|selector>` | 同上，或 `--x --y` 按坐标点；`--button left\|right\|middle` `--click-count 1\|2`         | 真实鼠标事件（`isTrusted:true`），带光标动画                                    |
| `fill <@ref\|selector> <值>` | `value`(必，缺了报错不会静默清空)                                                         | 走 native setter，兼容 React 受控组件                                    |
| `keys`            | `--text <文本>` **或** `--keys "<键序列>"`（二选一，同时给报错）                                | 键名见下                                                             |
| `scroll`          | `--args '{"to":"top\|bottom"}'`、`--dy`/`--dx`（相对）、`--absolute true` 配 `--dy`（绝对）、`--selector`/`--ref`（滚到元素）、`--settle-ms`(400，上限 5000) | 返回 `{x, y, maxY, atBottom}`                                      |
| `eval <表达式>`      | `expression`(必) `--frame-pattern <正则>` `--await-promise` `--return-by-value`     | 返回 `{value, type}`；value 常是 JSON 字符串，要**解两层**                    |
| `wait`            | `--selector` / `--text` / `--url-pattern` / `--network-idle` **四选一**；`--state visible\|attached`(visible) `--timeout-ms`(10000) `--idle-ms`(500) `--stale-ms`(15000) | WebSocket/SSE 等长连接不计入 network_idle                               |
| `frames`          | `--include-extensions`                                                        | `contextId:null` = 跨域框架，`eval --frame-pattern` 求值不了              |
| `status`          | —                                                                             | 扩展侧状态：WS 连接、attached tabs                                        |
| `cdp`             | `--args '{"method":"<CDP 方法>","params":{...}}'`                                | 逃生舱，直发任意 CDP                                                     |

**`keys` 的键名**：`Enter Tab Escape Backspace Delete Home End PageUp PageDown
ArrowLeft ArrowUp ArrowRight ArrowDown Space F1`–`F12`，单个字符（`a` `5`），
修饰键组合 `Ctrl+a` `Shift+Tab` `Meta+c`（合法修饰键 Ctrl|Alt|Shift|Meta）。
多个键用**空格分隔**依次按下。

## tab

| 命令                | 参数                                                        | 备注                                     |
| ----------------- | --------------------------------------------------------- | -------------------------------------- |
| `tab list`        | —                                                         | 全部 tab（含分组信息）                          |
| `tab find <正则>`   | `url_pattern`                                             | 按 URL 找，比 list 后自己筛快                   |
| `tab close`       | `--tab <id>` `--force`                                    | 只允许关 OWB 管理的组；关用户自己的 tab 报 `FORBIDDEN` |
| `tab close-group` | `--args '{"include_tasks":false}'`（默认 true）、`{"include_handoff":true}`（默认 false） | 一键清场                                   |

## net（抓包，详见 debugging.md）

| 命令              | 参数                                                                                     |
| --------------- | -------------------------------------------------------------------------------------- |
| `net start`     | `--clear`（默认清空旧 buffer，`--clear false` 保留）                                              |
| `net stop`      | —                                                                                      |
| `net list`      | `--url-pattern` `--limit` `--sort-by duration\|size` `--newest` `--include-orphans` `--include-extensions` |
| `net detail`    | `--request-id`(必) `--include-body` `--max-body`                                         |
| `net initiator` | `--request-id` 或 `--url-pattern`/`--url`                                                |
| `net capture`   | `--url-pattern`(必) `--trigger '<JS 表达式>'` `--timeout-ms`                                |

## har（详见 debugging.md）

| 命令              | 参数                                                                                                  |
| --------------- | --------------------------------------------------------------------------------------------------- |
| `har start`     | `--include-bodies` `--max-body-bytes` `--max-total-body-bytes` `--url-pattern` `--exclude-pattern` `--resource-types` `--capture-console` `--capture-screenshots` `--capture-storage` |
| `har save`      | `--args '{"filename":"名字"}'` `--title` `--tab`。落盘 `work/har/<名>.har`；**有活动任务时固定落 `tasks/<id>/recording.har`，filename 被忽略** |
| `har stop`      | `--title`。只停不存，**录完请直接用 `har save`**（自带 stop）                                                        |
| `har status`    | —                                                                                                   |
| `har to-replay` | `--path <work 下相对路径>` 或 `--args '{"har":{...}}'`；`--format python\|curl\|node` `--save`               |
| `har diff`      | `--baseline <路径>` `--current <路径>` `--save`                                                          |
| `har assert`    | `--path` + `--args '{"assertions":[...]}'`，断言类型见 debugging.md                                        |

## hook / debug / script / verify

这四组是逆向调试线，参数与用法在 **`debugging.md`**，那里有完整流程和示例。
下面只列名字与最关键的必填项：

| 命令                     | 必填/关键参数                                                       |
| ---------------------- | ------------------------------------------------------------- |
| `hook preset <名>`      | `preset xhr\|fetch\|crypto`（或 `--args '{"presets":[...]}'`）；`--reload` |
| `hook fn`              | `--function-path <全局路径>`；`--trace-args` `--trace-ret` `--trace-stack` `--hook-code` `--replacement` `--position` |
| `hook remove`          | `--preset` / `--args '{"presets":[...]}'`                      |
| `hook status`          | —                                                             |
| `hook logs`            | `--source` `--since-seq` `--limit`(100，上限 500) `--tab`；**返回字段叫 `events` 不是 logs** |
| `debug break-xhr`      | `--url-substring` 或 `--url-pattern`                            |
| `debug break-fn`       | `--function-path`；`--condition` `--url-pattern` `--line-number` `--column-number` |
| `debug break-remove`   | `--url-substring` / `--url-pattern` / `--key`                  |
| `debug frames`         | `--max-frames` `--prop-limit` `--include-global` `--auto-resume` |
| `debug step`           | `--action into\|over\|out`（默认 over）；没断住会明确报错                    |
| `debug resume`         | —                                                             |
| `debug console`        | `--enabled true\|false`                                        |
| `oracle`               | `--function-path` 或 `--object-id`；`--args '{"call_args":[...]}'`（**参数写错名会直接报错，不会假成功**）；`--freeze`(默认 true) |
| `script list`          | `--url-pattern` `--wait-ms` `--include-extensions`             |
| `script source`        | `--script-id`(必) `--max-chars`                                 |
| `script search`        | `--query`(必) `--url-pattern` `--limit` `--case-sensitive` `--is-regex` |
| `script patch`         | `--url-pattern`(必) `--code` `--patch-type prepend\|proxy_probe`（默认 prepend）；**下次加载生效** |
| `script unpatch`       | `--id` 或 `--url-pattern`                                       |
| `script watch`         | `--url-pattern` `--action` `--event` `--patch-type` `--code`   |
| `script watch-remove`  | `--id` 或 `--url-pattern`                                       |
| `verify signer`        | `--args '{"source":"(input)=>({sig:...})","samples":[...]}'`；只给 `calls` 走 dry-run。**裸 function 声明求值为 undefined，要用括号包起来** |
| `verify replay`        | `--url`(必) `--method` `--impersonate chrome\|edge\|firefox\|safari`（或带版本号）`--allow-redirects` `--max-body`，`--args` 传 `headers`/`body`/`params`。**需要 curl-impersonate 二进制** |
| `verify evidence`      | `--path`(必) `--args '{"content":...}'`                          |

## cookie

| 命令              | 参数                                                                              |
| --------------- | ------------------------------------------------------------------------------- |
| `cookie get`    | `--args '{"urls":["https://x.com/"]}'`（默认当前 tab 的 URL）                           |
| `cookie set`    | `--name`(必) `--value`(必)；可选 `--url` `--domain` `--path` `--secure` `--http-only` `--same-site Strict\|Lax\|None` `--expires`（Unix 秒或可解析日期串） |
| `cookie delete` | `--name`(必)                                                                     |

## state（登录态）

| 命令                | 参数                | 备注                                       |
| ----------------- | ----------------- | ---------------------------------------- |
| `state save <名>`  | `name`(必) `--tab` | cookie + localStorage + IndexedDB → `work/states/<名>.json` |
| `state load <名>`  | `name`(必) `--tab` | 恢复                                       |
| `state list`      | —                 | 已存清单                                     |
| `state delete <名>` | `name`(必)         | 删掉过期的                                    |
| `state export` / `state import` | `--args '{"state":{...}}'` | 扩展侧原语，只管当前页 storage；一般用上面四条 |

⚠️ 存的是**明文登录凭据**，`work/` 已 gitignore，但打包/分享前注意别外泄。

## env（环境模拟）

| 命令            | 参数                                                                                       |
| ------------- | ---------------------------------------------------------------------------------------- |
| `env set`     | 扁平：`--width` `--height` `--mobile` `--touch` `--device` `--timezone` `--locale` `--user-agent`；对象走 `--args`：`network:{latency,download,upload}`、`geolocation:{latitude,longitude,accuracy}`、`permissions:[...]`、`viewport:{...}` |
| `env reset`   | — ⚠️ **用完必须恢复**，否则用户浏览器一直卡在模拟状态                                                            |
| `env compare` | — 模拟前后环境对比                                                                                |

## file

| 命令           | 参数                                                                                | 文件落在哪                                                     |
| ------------ | --------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `download`   | `--url` 或 `--selector`；`--filename` `--timeout-ms`                                 | **浏览器所在机器**的系统下载目录，返回无 `dir`/`originalPath`               |
| `file fetch` | `--url`(必) `--timeout-ms`                                                          | daemon 侧下载 + 复制进 `work/downloads/`，返回 `path`/`originalPath`/`dir` |
| `upload`     | `--ref`/`--selector` + `--args '{"files":[{"name":"a.txt","base64":"..."}]}'`（**不收文件路径**） | 页面内构造 File，绕开文件系统                                          |
| `pdf`        | `--format A4\|Letter…` `--landscape` `--print-background` `--margin-top/-bottom/-left/-right` `--prefer-css-page-size` `--out <路径>` | 自动落盘，stdout 只回路径                                           |

## task / flow

| 命令               | 参数                                          | 备注                                   |
| ---------------- | ------------------------------------------- | ------------------------------------ |
| `task begin <标题>` | `title`(位置参数)                               | 建 `task: <标题>` 标签组 + `work/tasks/<id>/` 归档目录 |
| `task end`       | —                                           | 停录制、HAR 入档、清任务上下文；**不关标签页**          |
| `task list`      | —                                           | 历史任务                                 |
| `flow save <名>`  | `name`(必) `--task-id`                       | 按任务时间窗抓操作；没有活动任务报 `NEED_TASK`        |
| `flow run <名>`   | `name`(必) `--keep-tab-ids` `--continue-on-error` | 默认剥掉旧 tabId，用当前活动标签页解析               |
| `flow list`      | —                                           | 已存工作流                                |

## human / daemon

| 命令              | 参数                                                                          | 备注                                |
| --------------- | --------------------------------------------------------------------------- | --------------------------------- |
| `handoff`       | `--reason "<给用户看的话>"`                                                        | tab 进「✋ OWB 等你操作」橙色组              |
| `wait-user`     | `--condition url_change\|selector\|text`（**默认 url_change**）`--selector` `--text` `--timeout-ms`(280000) `--clear` | 登录场景**务必显式给条件**，否则不换 URL 的登录会干等到超时 |
| `daemon-status` | —                                                                           | 模式（local/relay）、中转 URL、扩展是否在线、当前任务 |
| `reload-ext`    | —                                                                           | 让扩展重载自己（改完扩展代码用，免去手点 chrome://extensions） |

## 环境变量（daemon 侧，启动时读）

| 变量                 | 作用                                        |
| ------------------ | ----------------------------------------- |
| `OWB_PORT`         | daemon 端口（默认 43917）                       |
| `OWB_WORK_DIR`     | `work/` 目录位置（归档、HAR、登录态、下载都落这里）           |
| `OWB_RELAY_URL`    | 中转地址，配合下面一条启用中转模式，见 `relay.md`            |
| `OWB_RELAY_TOKEN`  | 中转 token，两端必须一致                           |
| `OWB_CURL_BINARY`  | curl-impersonate 路径（`verify replay` 用）    |

CLI 侧（每条命令启动时读）：

| 变量                | 作用                                                                 |
| ----------------- | ------------------------------------------------------------------ |
| `OWB_NO_EXT_RETRY` | 设为非 `0` 则**跳过 `NO_EXTENSION` 的退避重试**（默认累计约 35 秒）。用在自动化测试、或你明知浏览器没开着、不想每条命令干等 35 秒的时候 |

⚠️ **daemon 只在启动时读环境变量**。改了这些要**先停掉正在跑的 daemon** 再让它
重新拉起，否则新值不生效。

#!/usr/bin/env node
/**
 * MCP (stdio) 接入面：把 ctl 通道的桥工具暴露为 MCP tools。
 *
 * 运行：node src/mcp_server.js（或 bin owb-mcp）
 * 依赖：daemon 已在运行（ws://127.0.0.1:18086，OWB_PORT 环境变量覆盖）。
 *
 * AI 工具配置示例（Kimi Code config.toml / Claude Code mcp 配置同构）：
 *   [mcp_servers.owb]
 *   command = "node"
 *   args = ["C:/Users/coding/python/09/open-web-bridge/daemon/src/mcp_server.js"]
 *
 * 协议映射：
 *   MCP tools/call  → ctl {"type":"call","id","name","args","timeout"}
 *   ctl result      → MCP CallToolResult（ok=false → isError=true）
 *   daemon.* 本地工具在 MCP 侧暴露为 daemon_*（MCP 工具名不含点号），调用时还原。
 *   事件面（subscribe/events）不走 MCP；需要事件时用 daemon_hook_logs 轮询。
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import WebSocket from "ws";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { HOST, PORT } from "./server.js";

const CTL_URL = `ws://${HOST}:${PORT}/ctl`;
const CALL_TIMEOUT_S = 120.0; // ctl 侧上限 300；MCP 默认给 120，重活（截图/导航慢站）可调大

// ---------------------------------------------------------------------------
// 工具清单（与 extension/background.js 的 tools 表 + daemon call_local 对齐）
// inputSchema 一律宽松 object——参数真源在扩展/daemon 侧，双份声明必然漂移；
// 描述里给关键参数，参数真源在扩展/daemon 侧。
// ---------------------------------------------------------------------------

const _EXT_TOOLS = [
  ["status", "桥状态：WS 连接、已 attach 的 tab 列表。排障第一调用。"],
  [
    "list_tabs",
    "列出浏览器全部 tab。返回 {tabs:[{tabId,url,title,active,attached,group}], count}。",
  ],
  [
    "find_tab",
    "按 url_pattern（JS 正则，必填；缺省不会匹配全部）找 tab。返回 {tabs:[{tabId,url,title}], count}。参数: url_pattern",
  ],
  [
    "navigate",
    "导航当前/指定 tab 到 url；new_tab:true 新开并自动编入「OWB 分析」组。参数: url, tabId?, new_tab?, timeout_ms?",
  ],
  [
    "evaluate",
    "在页面上下文执行任意 JS 表达式。默认 returnByValue:true 返回 {value,type}；传 returnByValue:false 额外返回 objectId/className/description（objectId 可喂给 oracle_call）。参数: expression, tabId?, awaitPromise?, returnByValue?, frame_pattern?",
  ],
  [
    "history",
    "历史导航：后退/前进/刷新（navigate 只能往前）。返回新的 url + changed。参数: action（back|forward|reload）, tabId?, bypass_cache?, timeout_ms?",
  ],
  [
    "scroll",
    "滚动页面或把元素滚进视口，返回滚动后的 {x,y,maxY,atBottom}（用 evaluate 手搓 scrollBy 会拿到 undefined）。懒加载场景滚完配 read_page since_last 看新增。参数: y?(正=向下，默认600), x?, to?(top|bottom), absolute?(true=scrollTo), selector?|ref?, settle_ms?, tabId?",
  ],
  [
    "close_tab",
    "关闭 tab（默认只许关 OWB 组的 tab；force:true 强制）。参数: tabId?, force?",
  ],
  [
    "close_group",
    "一键清场：关闭「OWB 分析」组和 task: 组的全部 tab，用户自己的 tab 绝不动；「✋ OWB 等你操作」组默认保留（用户正在那儿操作），include_handoff:true 才一起关。参数: include_tasks?(默认true), include_handoff?(默认false)",
  ],
  [
    "screenshot",
    "截图（format: png|jpeg，quality 可调；selector 或 ref（@eN，read_page 产出）二选一裁剪元素；full_page 整页）。base64 在返回值的 data 字段（不是 base64）。参数: format?, quality?, selector?|ref?, full_page?, tabId?",
  ],
  [
    "click",
    "DOM 级点击（selector 或 ref（@eN，read_page 产出）二选一 + scrollIntoView + .click()；选择器穿透 open shadow DOM）。返回 navigated 明确说明 URL 有没有变（click 成功不等于跳转了）。disabled 元素报 ELEMENT_DISABLED 而不是假成功。参数: selector?|ref?, tabId?",
  ],
  [
    "fill",
    "填表单（selector 或 ref 二选一；穿透 open shadow DOM）：native setter 赋值 + input/change 事件绕 React 受控组件；checkbox/radio 自动改 .checked（value 传 false/0/off 即取消勾选）；contenteditable 写 textContent。<select> 传了不存在的 option 会报 FILL_REJECTED 而不是假成功。参数: selector?|ref?, value, tabId?",
  ],
  [
    "send_keys",
    "真实按键事件。keys: 空格分隔的按键序列，支持具名键（Enter Tab Escape Backspace Delete Home End PageUp PageDown Arrow* Space F1-F12）、单字符（a 1 …）和修饰键组合（\"Ctrl+a\" \"Shift+Tab\" \"Meta+c\"）。text: 整段插入（走 insertText，不产生按键事件）。两者互斥。参数: keys? 或 text?, tabId?",
  ],
  [
    "cdp",
    '任意 CDP 方法逃生舱。参数: method（如 "DOM.getDocument"）, params?, tabId?',
  ],
  ["network_start", "开始抓包（Network.enable，全量收 body）。参数: tabId?"],
  [
    "network_stop",
    "停止抓包（Network.disable），已抓缓冲保留给 network_list。参数: tabId?",
  ],
  [
    "network_list",
    "列出已抓请求，按 url_pattern（JS 正则）过滤；默认剔除其他扩展的 chrome-extension:// 请求（include_extensions:true 可要回）。返回 {requests:[{request_id,requestId,method,url,status,type,finished,failed}], count, matched, truncated, buffered}。刚发的请求用 newest:true 从最近往回取。参数: url_pattern?, limit?, newest?, include_extensions?, tabId?",
  ],
  [
    "network_detail",
    "单请求全量：headers/postData/响应 body（base64 解码，max_body 可调）。request_id 取自 network_list（requestId 同名可用）。参数: request_id, max_body?, tabId?",
  ],
  [
    "get_initiator",
    "拿请求调用栈（哪个 JS 函数发的）——定位请求来源第一利器。可给 request_id（取自 network_list），也可直接给 url（子串）或 url_pattern（正则），取最近一条匹配。参数: request_id?|url?|url_pattern?, tabId?",
  ],
  [
    "record_start",
    "HAR 录制开：独立于探查缓冲，无淘汰、主动收 body、记 timing/WebSocket；附 console/storage/截图增强流。参数: tabId?, include_bodies?(默认true), url_pattern?(白名单，JS 正则), exclude_pattern?(黑名单，JS 正则), resource_types?(如['xhr','fetch']), capture_console?(默认true), capture_screenshots?(默认false), capture_storage?(默认true), max_body_bytes?, max_total_body_bytes?",
  ],
  [
    "record_stop",
    "停录制，产出 HAR 1.2 对象返回；不指定 tabId 时停所有活动 recorder 合并为多 page HAR。参数: tabId?, title?",
  ],
  [
    "record_status",
    "查录制状态（是否在录、entry 数、body 字节、增强流计数）。参数: tabId?(缺省汇总全部)",
  ],
  [
    "download",
    "E1 文件下载：走 chrome.downloads（Chrome 150 起 CDP 的下载控制是 browser-level，扩展够不到），等下载完成返回绝对路径。参数: url?|selector?(二选一), filename?(仅 url 模式), tabId?, timeout_ms?",
  ],
  [
    "upload",
    "E2 文件上传：页面内 DataTransfer+File 直接塞 input.files（无需文件系统，relay 也能用）。参数: selector, files:[{name,base64,mime?}], tabId?",
  ],
  [
    "print_pdf",
    "E3 PDF 导出：Page.printToPDF；base64 在返回值的 data 字段（不是 base64）。参数: tabId?, format?(A4/Letter/Legal/Tabloid/Ledger/A0-A6), landscape?, print_background?, margin_top/bottom/left/right?, prefer_css_page_size?",
  ],
  [
    "list_frames",
    "E4 iframe 列表：返回树形 main + 拍平的 frames[]（frameId/url/name/contextId/depth）。contextId=null 的是跨源 frame——扩展的 page 级 debugger 会话进不去，evaluate frame_pattern 对它无效，只能从 network_detail 读它的文档响应。evaluate 的 frame_pattern 可按完整 URL / name / frameId 匹配。参数: include_extensions?, tabId?",
  ],
  [
    "emulate",
    "D 环境模拟：设备视口/网络节流/地理/时区/语言/权限/UA 一次性覆盖。一条都没识别到会报 BAD_ARGS（不再返回 applied:[] 的假成功）。locale 只影响 Intl，不改 navigator.language（返回的 notes 里会说明）。device 也可写作 viewport 或顶层 width/height。参数: tabId?, device?{width,height,mobile,touch,device_scale_factor}, network?{offline,latency,download,upload}, geolocation?{latitude,longitude}, timezone?, locale?, permissions?[], user_agent?",
  ],
  [
    "emulate_reset",
    "清空 emulate 的全部覆盖；device 清完会回读 innerWidth 校验，清不掉报 RESET_INCOMPLETE（不再静默假成功）。参数: tabId?",
  ],
  [
    "capture_request",
    "宏工具·一键证据包：触发动作 → 抓目标请求全量 + initiator 栈 + 同期新请求清单。参数: url_pattern（JS 正则）, trigger?{expression}, timeout_ms?, tabId?",
  ],
  [
    "script_list",
    "枚举页面全部 JS（含 eval/VM 动态脚本），并附当前生效的 script_patch/watch_script 清单（patches/watchers）。默认剔除其他扩展注入的脚本（include_extensions:true 可要回）。⚠️ 启用 Debugger 关 JIT，用完 break_remove 顺手 disable。参数: url_pattern?（JS 正则）, include_extensions?, tabId?",
  ],
  [
    "script_source",
    "按 script_id 取源码（大文件配 daemon_evidence_write 落盘）。参数: script_id, max_chars?, tabId?",
  ],
  [
    "search_code",
    '全部脚本里搜字符串（is_regex:true 才按正则），返回命中位置+上下文。默认剔除其他扩展的注入脚本（否则真实站点上命中的常常全是别的扩展）。参数: query, is_regex?, case_sensitive?, url_pattern?（JS 正则，按脚本 URL 过滤）, include_extensions?, limit?, tabId?',
  ],
  [
    "cookie_get",
    "读 cookie（含 HttpOnly）。参数: urls?（字符串数组，缺省按 tab 当前 url）, tabId?",
  ],
  [
    "cookie_set",
    "写 cookie。sameSite 只收 Strict|Lax|None（None 需 secure:true）；expires 是 Unix 秒（数字；ISO 字符串会自动转）。参数: name, value, domain?, path?, secure?, httpOnly?, sameSite?, expires?",
  ],
  ["cookie_delete", "删 cookie。参数: name, url?, tabId?"],
  [
    "hook_preset",
    "预设 hook：xhr/fetch 记请求全量，crypto 记 btoa/atob/JSON.stringify I/O。文档最早期注入+自动 reload。参数: presets?|preset?（xhr|fetch|crypto）, tabId?",
  ],
  [
    "hook_function",
    "自定义 hook 任意函数：before/after/replace + trace 入参/返回/栈；non_overridable 防覆盖。注入早于页面函数，模板自动轮询等待。参数: function_path, position?, hook_code?, replacement?, trace_args?, trace_ret?, trace_stack?, non_overridable?, tabId?",
  ],
  [
    "hook_remove",
    "按预设名移除 hook（缺省全部移除）。参数: preset?|presets?, tabId?",
  ],
  [
    "hook_status",
    "列出已注册 hook 预设与注入绑定状态（返回 {tabId, presets, bindingReady}，不含命中计数）。参数: tabId?",
  ],
  [
    "oracle_call",
    "直接调用页面函数产出确定性样本（默认冻结 Date.now/Math.random 作元数据），供 daemon_verify_signer 离线对拍。function_path 是 window 下的点分路径（\"app.sign\"），不是表达式；路径不是函数会报 NOT_A_FUNCTION（不再是 ok:true 里藏 ok:false）。闭包内的函数用 frame_read 拿 object_id。参数: function_path 或 object_id, call_args?, freeze?（默认 true）, tabId?",
  ],
  [
    "break_xhr",
    "XHR 断点：断在匹配请求发出那一刻。url_substring 是纯子串（不是正则；别名 url_pattern 同义）。参数: url_substring, tabId?",
  ],
  [
    "break_function",
    "函数断点：window 路径（function_path）或 url 正则+行号（url_pattern 是 JS 正则 + line_number）。参数: function_path? 或 url_pattern+line_number, tabId?",
  ],
  [
    "break_remove",
    "移除断点；无断点时顺手 Debugger.disable 恢复 JIT。参数: key?|url_substring?, tabId?",
  ],
  [
    "frame_read",
    "断住时读调用帧局部变量（frozen-snapshot，默认读完自动 resume 不卡页面）。参数: max_frames?, auto_resume?, tabId?",
  ],
  ["step", "断住时单步：over/into/out。参数: action, tabId?"],
  ["resume", "恢复执行。参数: tabId?"],
  [
    "console_stream",
    "页面 console/异常流开关。开启后用 daemon_hook_logs({source:\"console\"}) 取事件（MCP 侧没有事件推送面）。参数: enabled, tabId?",
  ],
  [
    "export_state",
    "导出完整登录态：cookie（含 HttpOnly）+ localStorage/sessionStorage + IndexedDB。参数: tabId?",
  ],
  [
    "import_state",
    "导入 export_state 产物恢复登录态（IndexedDB 只写已存在的库）。参数: state, tabId?",
  ],
  [
    "script_patch",
    "Fetch 拦截脚本响应并改写源码（prepend 插桩/proxy_probe 行为探针）。⚠️ proxy_probe 会改变脚本运行行为，行为敏感站点慎用。参数: url_pattern（CDP glob，不是正则）, patch_type（prepend|proxy_probe，别名 type 同义；非法值报 BAD_ARGS）, code?, tabId?",
  ],
  [
    "script_unpatch",
    "移除 script_patch（按 id 或 url_pattern，缺省全清）。这里的 url_pattern 是与注册时逐字相等比对（不是匹配），拿 script_patch 返回的 patch.pattern 原样传。参数: id?|url_pattern?, tabId?",
  ],
  [
    "watch_script",
    "监视脚本加载（匹配 url_pattern 即记录；action:patch 命中即改写），适合捕获动态加载的脚本。命中事件用 daemon_hook_logs 轮询取。参数: url_pattern（CDP glob）, action（notify|patch，别名 event 同义）?, tabId?",
  ],
  [
    "watch_remove",
    "移除 watch_script（按 id 或 url_pattern，缺省全清）。url_pattern 与注册时逐字相等比对（不是匹配），拿 watch_script 返回的 watcher.pattern 原样传。参数: id?|url_pattern?, tabId?",
  ],
  [
    "env_compare",
    "环境指纹对比：navigator/screen/window/document/perf/features 四批基准采集比对。参数: tabId?",
  ],
  [
    "wait_for",
    "等待原语：selector 出现（state:visible/attached）/ text 出现 / url_pattern（JS 正则）匹配 / network_idle 网络空闲，四选一（多给或不给都报 BAD_ARGS）。参数: selector?|text?|url_pattern?|network_idle?, state?, timeout_ms?(默认10s 上限110s), idle_ms?, tabId?",
  ],
  [
    "read_page",
    "语义快照：可交互元素（含 contenteditable、open shadow DOM 内的元素）打 @eN 稳定 ref（同文档内跨调用复用，click/fill/screenshot 的 ref 参数直接吃；导航后 ref 从 e1 重排）。snapshot 返回 nodes:[{ref,role,name,line,hash}] + lines/text 两个同义的整段文本；line 形如 \"@e5 textbox \\\"邮箱\\\" type=email required\"，并按元素带上 checked/unchecked、href=、values=[…]、disabled。name 依次取 aria-label/alt/placeholder/<label>/name/文本。iframes 字段列出页面内的 iframe（跨源内容不在快照里）。mode: snapshot(默认)/article(正文→markdown，非文章页返回空 content + reason)/text。参数: mode?, max_chars?, max_nodes?, since_last?, tabId?",
  ],
  [
    "mouse_click",
    "真实鼠标点击（CDP Input 域 + 页面内 AI 光标贝塞尔动画与点击涟漪，用户在旁观看时用这条，纯后台操作用 click）。canvas/地图这类没有元素可选的地方直接传 x/y 视口坐标。参数: selector?|ref?|x+y, button?, click_count?, tabId?",
  ],
  [
    "handoff",
    "把 tab 交还用户操作（编入「✋ OWB 等你操作」橙色组 + 事件推流），配 wait_user 使用。参数: reason?, tabId?",
  ],
  [
    "wait_user",
    "挂起直到用户接管：url_change(默认)/selector/text 三选一条件。⚠️ timeout_ms 默认/上限 280s，经 MCP 调用需把 timeout 参数调到 ≥ timeout_ms/1000+10。参数: condition?, selector?, text?, timeout_ms?, tabId?",
  ],
  // 扩展侧 task_context 是 daemon task_begin/task_end 内部联动的
  // 管道（建/清 task:<title> 标签分组），不注册进 MCP。
];

const _DAEMON_TOOLS = [
  ["status", "daemon 状态：扩展是否连接、事件 seq、订阅数。参数: 无"],
  [
    "hook_logs",
    "查 hook/console/watch_script 命中事件（ring buffer）。返回 {events:[...], count, event_seq}——字段名是 events 不是 logs。source 缺省只回 hook:* 源，支持前缀匹配（\"hook\" 命中 hook:xhr/hook:fn…）；console_stream 的事件传 source:\"console\"。多 tab 同时挂 hook 时传 tabId 过滤。参数: since_seq?(别名 since), limit?, source?, tabId?",
  ],
  [
    "verify_signer",
    "Node vm 沙箱离线运行提取出的函数。source 必须求值为函数表达式（\"(input) => ({...})\" 或 \"(function(input){...})\"；裸 function 声明求值为 undefined 会报错）。给 samples:[{id,input,expected}]（expected 来自 oracle_call）才做对拍，返回 pass_rate；只给 calls:[{args:[...]}] 走 dry_run 仅回算出的值，不产 pass_rate。全部样本对拍失败返回 VERIFY_FAILED（不是 ok:true）。参数: source(=signer_code), samples?|calls?",
  ],
  [
    "replay",
    "curl-impersonate 带浏览器 TLS 指纹重放请求，验证请求能否脱离浏览器独立复现。参数: method, url, headers?, body?, impersonate?（默认 chrome）",
  ],
  [
    "evidence_write",
    "证据落盘到 work/（拒绝路径穿越）。参数: path（相对 work/）, content（任意 JSON）",
  ],
  [
    "task_begin",
    "开始任务：建 work/tasks/<id>/ 归档目录 + 扩展侧 task:<title> 标签分组（之后 navigate new_tab 自动入组）。参数: title?",
  ],
  [
    "task_end",
    "结束任务：写 task.json 摘要（事件区间/分组 tab 统计）并清当前任务。参数: 无",
  ],
  ["task_list", "列出全部任务与当前进行中任务。参数: 无"],
  [
    "workflow_save",
    "把一段 task 期间的浏览器操作固化为可重放工作流（从审计日志提取，先 task_begin 包住流程）。参数: name, task_id?",
  ],
  [
    "workflow_run",
    "重放工作流：逐步执行，默认剥 tabId 解析到当前活动 tab、首败即停。参数: name, keep_tab_ids?, continue_on_error?",
  ],
  ["workflow_list", "列出已存工作流。参数: 无"],
  [
    "state_save",
    "把当前 tab 登录态（cookie/storage/IndexedDB）按名字存进会话库，不经过 agent 上下文。参数: name, tabId?",
  ],
  ["state_load", "按名字恢复登录态到 tab。参数: name, tabId?"],
  ["state_list", "列出会话库。参数: 无"],
  ["state_delete", "删除会话库里的登录态（过期账号清理）。参数: name"],
  [
    "har_save",
    "停录制并把 HAR 落盘到 work/（有活动 task 进 task 目录，否则 har/<名>.har）。参数: tabId?, filename?, title?",
  ],
  [
    "download",
    "E1 下载编排：扩展 download 落盘到 work/downloads/<原名>，返回路径。参数: url?|selector?, tabId?, timeout_ms?",
  ],
  [
    "har_to_replay",
    "C7：HAR → 可重放脚本（python/curl/node），动态签名头标 <DYNAMIC> 占位。参数: har?|path?, format?(python|curl|node), save?(落盘到 replay/)",
  ],
  [
    "har_diff",
    "C8：两份 HAR 按 method+urlPath 对比（请求增删/状态码/响应体/header 漂移）。参数: baseline(har|path), current(har|path), save?",
  ],
  [
    "har_assert",
    "C9：校验 HAR 是否满足断言集。assertions[] 每条的字段：" +
      "{type:\"request_exists\"|\"request_absent\", url_pattern}、" +
      "{type:\"response_status\", url_pattern, status}（别名 code/expected）、" +
      "{type:\"response_contains\", url_pattern, value}（别名 text/contains）、" +
      "{type:\"min_requests\", count}（别名 min）。url_pattern 是 JS 正则。assertions 不能为空。判定看 data.ok / data.failed —— 外层 ok 只表示校验跑完了。har 可传对象或 JSON 字符串。参数: har?|path?, assertions[]",
  ],
];

export const _TOOLS = new Map(); // mcp 名 -> [ctl 名, 描述]
for (const [name, desc] of _EXT_TOOLS) _TOOLS.set(name, [name, desc]);
for (const [name, desc] of _DAEMON_TOOLS) {
  // UX-85: daemon 侧工具（不经浏览器）。MCP 名带 daemon_ 前缀、ctl 名带
  // daemon. 前缀——描述里点明，省得 AI 拿扩展侧的裸名去调。
  _TOOLS.set(`daemon_${name}`, [`daemon.${name}`, `【daemon 侧】${desc}`]);
}

class CtlClient {
  constructor() {
    this.ws = null;
    this.pending = new Map(); // id -> {resolve, timer}
    this.counter = 0;
  }

  _ensure() {
    if (this.ws !== null) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(CTL_URL, { maxPayload: 64 * 1024 * 1024 });
      ws.once("open", () => {
        this.ws = ws;
        ws.on("message", (data) => {
          let msg;
          try {
            msg = JSON.parse(data.toString());
          } catch (e) {
            return;
          }
          if (msg.type === "result") {
            const ent = this.pending.get(String(msg.id));
            if (ent) {
              this.pending.delete(String(msg.id));
              clearTimeout(ent.timer);
              ent.resolve(msg);
            }
          }
        });
        ws.on("close", () => {
          for (const [, ent] of this.pending) {
            clearTimeout(ent.timer);
            ent.reject(new Error("ctl disconnected"));
          }
          this.pending.clear();
          this.ws = null;
        });
        ws.on("error", () => {});
        resolve();
      });
      ws.once("error", reject);
    });
  }

  async call(name, args, timeout) {
    await this._ensure();
    const cid = `mcp-${++this.counter}`;
    return new Promise((resolve, reject) => {
      // ctl 侧超时之外多给 10s 余量
      const timer = setTimeout(
        () => {
          this.pending.delete(cid);
          reject(new Error("ctl call timeout"));
        },
        (timeout + 10) * 1000,
      );
      this.pending.set(cid, { resolve, reject, timer });
      this.ws.send(
        JSON.stringify({ type: "call", id: cid, name, args, timeout }),
      );
    });
  }
}

const _ctl = new CtlClient();

function _errResult(code, message) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ ok: false, error: { code, message } }),
      },
    ],
    isError: true,
  };
}

const server = new Server(
  { name: "open-web-bridge", version: "0.9.1" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [..._TOOLS.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([mcpName, [, desc]]) => ({
      name: mcpName,
      description: desc,
      inputSchema: { type: "object", additionalProperties: true },
    })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const entry = _TOOLS.get(request.params.name);
  if (!entry) {
    return _errResult("UNKNOWN_TOOL", `unknown tool: ${request.params.name}`);
  }
  const ctlName = entry[0];
  const args = { ...(request.params.arguments || {}) };
  // BUG-3: wait_user internal default (280s) exceeds MCP default (120s).
  // When AI omits timeout, auto-extend so wait_user own TIMEOUT fires
  // instead of MCP cutting it off prematurely.
  let timeout;
  if (args.timeout !== undefined) {
    timeout = Number(args.timeout);
  } else if (ctlName === "wait_user") {
    const waitMs = Number(args.timeout_ms) || 280000;
    timeout = Math.ceil(waitMs / 1000) + 10;
  } else {
    timeout = CALL_TIMEOUT_S;
  }
  delete args.timeout;
  let res;
  try {
    res = await _ctl.call(ctlName, args, timeout);
  } catch (e) {
    return _errResult(
      "CTL_UNREACHABLE",
      `daemon 不可达（${CTL_URL}）：` +
        `${e && e.message ? e.message : e}。` +
        "先启动 daemon：cd daemon && npm start",
    );
  }
  if (res.ok) {
    return {
      content: [
        { type: "text", text: JSON.stringify(res.data ?? null, null, 2) },
      ],
      isError: false,
    };
  }
  const err = res.error || {};
  return _errResult(
    err.code || "INTERNAL",
    String(err.message !== undefined ? err.message : err),
  );
});

async function amain() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// 仅作为主模块直接运行时才启动（供测试 import 时不占 stdio）
const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  // stdio 协议占 stdout；任何 print/日志只能去 stderr
  if (process.env.OWB_MCP_DEBUG) {
    console.error(`[owb-mcp] ctl=${CTL_URL} tools=${_TOOLS.size}`);
  }
  amain().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

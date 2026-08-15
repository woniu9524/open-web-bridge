#!/usr/bin/env node
/**
 * owb — Open Web Bridge CLI：agent/人共用的唯一接入面。
 *
 * 设计：
 *   - 任何能跑 shell 的 agent（Claude Code / Kimi Code / Codex …）直接调用，
 *     零客户端配置；配套 skill 见仓库 owb-skills/owb/SKILL.md。
 *   - 79 个桥工具收敛为「高频顶层动词 + 12 个命令组」，`owb help` 渐进披露。
 *   - daemon 未启动时自动拉起（--no-autostart 关闭），用户从「装完就能用」开始。
 *
 * 用法：
 *   owb                          自检（daemon/扩展连接状态 + 下一步提示）
 *   owb <命令> [位置参数] [--flag value ...]
 *   owb call <ctl工具名> [--args '<json>']    通用逃生口（别名之外的调法）
 *   owb help [组名]              命令清单 / 组内详情
 *
 * 参数规则：
 *   --foo-bar v   →  args.foo_bar = v（v 可 JSON 解析则解析，否则原样字符串）
 *   --tab 123     →  args.tabId = 123
 *   --args '<json>' 整体合并（优先级最高）
 *   click/fill 的首个位置参数以 @ 开头视为 ref，否则视为 CSS selector
 *
 * 输出：ok → data JSON 到 stdout；错误 → stderr 一行 `error CODE: message`，
 * 退出码 1（用法错误 2）。--raw 输出完整 result 信封。
 */
import WebSocket from "ws";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "./ismain.js";
import { HOST, PORT } from "./server.js";

const CTL_URL = `ws://${HOST}:${PORT}/ctl`;
const CALL_TIMEOUT_S = 120; // ctl 侧上限 300；重活（截图/慢站导航）用 --timeout 调大
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// 命令表：CLI 名 → { ctl 工具名, 位置参数映射, 描述 }
// 参数真源在扩展/daemon 侧（宽松透传，避免双份声明漂移）；pos 只映射高频用法。
// ---------------------------------------------------------------------------

// target 位置参数：@ 开头 → ref，否则 selector
const TARGET = { target: true };

const GROUPS = {
  core: {
    open: { ctl: "navigate", pos: ["url"], desc: "open a url (--new-tab opens a new tab)" },
    back: { ctl: "history", preset: { action: "back" }, desc: "go back" },
    forward: { ctl: "history", preset: { action: "forward" }, desc: "go forward" },
    reload: { ctl: "history", preset: { action: "reload" }, desc: "reload (--bypass-cache for a hard reload)" },
    page: { ctl: "read_page", desc: "semantic snapshot (@eN refs for click/fill); --mode article|text, --since-last for a diff" },
    shot: { ctl: "screenshot", desc: "screenshot" },
    click: { ctl: "click", pos: [TARGET], desc: "click an @ref or selector (--mouse switches to real mouse events)" },
    "click-mouse": { ctl: "mouse_click", pos: [TARGET], desc: "click with real mouse events (isTrusted, with a visible cursor animation)" },
    fill: { ctl: "fill", pos: [TARGET, "value"], desc: "fill an input (native setter, works with React controlled components)" },
    keys: { ctl: "send_keys", desc: "keyboard input: --text uses insertText, --keys sends real key events (pick one)" },
    scroll: { ctl: "scroll", desc: "scroll the page" },
    eval: { ctl: "evaluate", pos: ["expression"], desc: "evaluate a JS expression in the page" },
    wait: { ctl: "wait_for", desc: "wait for --selector / --text / --url-pattern / --network-idle" },
    frames: { ctl: "list_frames", desc: "list iframes (pair with eval --frame-pattern)" },
    status: { ctl: "status", desc: "extension-side state: WS connection, attached tabs" },
    cdp: { ctl: "cdp", desc: "send any raw CDP command (escape hatch)" },
  },
  tab: {
    "tab list": { ctl: "list_tabs", desc: "list all tabs" },
    "tab find": { ctl: "find_tab", pos: ["url_pattern"], desc: "find a tab by url regex" },
    "tab close": { ctl: "close_tab", desc: "close a tab (--tab to pick one)" },
    "tab close-group": { ctl: "close_group", desc: "clean up: close the OWB scratch group and every task: group" },
  },
  net: {
    "net start": { ctl: "network_start", desc: "start capturing network traffic" },
    "net stop": { ctl: "network_stop", desc: "stop capturing" },
    "net list": { ctl: "network_list", desc: "list captured requests; --sort-by duration|size for slowest/heaviest, --url-pattern to filter" },
    "net detail": { ctl: "network_detail", desc: "one request in full (headers + body)" },
    "net initiator": { ctl: "get_initiator", desc: "the call stack that initiated a request" },
    "net capture": { ctl: "capture_request", desc: "macro: run a trigger action and capture the matching request" },
  },
  har: {
    "har start": { ctl: "record_start", desc: "start recording (full HAR 1.2)" },
    "har save": { ctl: "daemon.har_save", desc: "stop recording and write to disk (use this when done, it stops for you)" },
    "har stop": { ctl: "record_stop", desc: "stop without saving; when done recording use har save directly, stopping first makes save fail" },
    "har status": { ctl: "record_status", desc: "recording status" },
    "har to-replay": { ctl: "daemon.har_to_replay", desc: "HAR to a python/curl/node replay script" },
    "har diff": { ctl: "daemon.har_diff", desc: "diff two HARs for drift" },
    "har assert": { ctl: "daemon.har_assert", desc: "assert against a HAR" },
  },
  hook: {
    "hook preset": { ctl: "hook_preset", pos: ["preset"], desc: "inject a preset hook: xhr|fetch|crypto" },
    "hook fn": { ctl: "hook_function", desc: "hook any function and record its arguments and return value" },
    "hook remove": { ctl: "hook_remove", desc: "remove a hook" },
    "hook status": { ctl: "hook_status", desc: "which hooks are installed" },
    "hook logs": { ctl: "daemon.hook_logs", desc: "pull hook events (polling)" },
  },
  debug: {
    "debug break-xhr": { ctl: "break_xhr", desc: "XHR breakpoint (pair with debug frames to read the frozen state)" },
    "debug break-fn": { ctl: "break_function", desc: "function breakpoint" },
    "debug break-remove": { ctl: "break_remove", desc: "remove a breakpoint" },
    "debug frames": { ctl: "frame_read", desc: "read call frames at a breakpoint (frozen snapshot)" },
    "debug step": { ctl: "step", desc: "step" },
    "debug resume": { ctl: "resume", desc: "resume execution" },
    "debug console": { ctl: "console_stream", desc: "stream console output" },
    oracle: { ctl: "oracle_call", desc: "call a page function deterministically (time and randomness frozen)" },
  },
  script: {
    "script list": { ctl: "script_list", desc: "list the scripts a page loaded" },
    "script source": { ctl: "script_source", desc: "get a script source" },
    "script search": { ctl: "search_code", desc: "search across all script sources" },
    "script patch": { ctl: "script_patch", desc: "patch a script (takes effect on next load)" },
    "script unpatch": { ctl: "script_unpatch", desc: "undo a patch" },
    "script watch": { ctl: "watch_script", desc: "watch for a script to load" },
    "script watch-remove": { ctl: "watch_remove", desc: "remove a watcher" },
  },
  cookie: {
    "cookie get": { ctl: "cookie_get", desc: "read cookies" },
    "cookie set": { ctl: "cookie_set", desc: "write a cookie" },
    "cookie delete": { ctl: "cookie_delete", desc: "delete a cookie" },
  },
  state: {
    "state save": { ctl: "daemon.state_save", pos: ["name"], desc: "save a site login (cookies + storage + IndexedDB)" },
    "state load": { ctl: "daemon.state_load", pos: ["name"], desc: "restore a saved login" },
    "state list": { ctl: "daemon.state_list", desc: "list saved logins" },
    "state delete": { ctl: "daemon.state_delete", pos: ["name"], desc: "delete a saved login" },
    "state export": { ctl: "export_state", desc: "export the current page storage (extension-side primitive)" },
    "state import": { ctl: "import_state", desc: "import storage (extension-side primitive)" },
  },
  env: {
    "env set": { ctl: "emulate", desc: "emulate device / network throttling / geolocation / timezone / locale / UA" },
    "env reset": { ctl: "emulate_reset", desc: "reset emulation" },
    "env compare": { ctl: "env_compare", desc: "compare the environment before and after emulation" },
  },
  file: {
    download: { ctl: "download", desc: "download via the browser" },
    upload: { ctl: "upload", desc: "upload a file to the page (DataTransfer, no filesystem access)" },
    pdf: { ctl: "print_pdf", desc: "export the page as PDF" },
    "file fetch": { ctl: "daemon.download", desc: "fetch a URL daemon-side into work/downloads/" },
  },
  task: {
    // BUG-110: 位置参数原来映射成 name，但 daemon 侧 task_begin 读的是
    // args.title —— 标题一路丢到底，任务组退化成 "task: <时间戳>"，
    // 「一个任务一个可读分组」这个核心卖点直接失效。
    "task begin": { ctl: "daemon.task_begin", pos: ["title"], desc: "begin a task (creates a tab group and archive dir)" },
    "task end": { ctl: "daemon.task_end", desc: "end a task (files the HAR automatically)" },
    "task list": { ctl: "daemon.task_list", desc: "list tasks" },
  },
  flow: {
    "flow save": { ctl: "daemon.workflow_save", pos: ["name"], desc: "save the flow you just ran as a workflow" },
    "flow run": { ctl: "daemon.workflow_run", pos: ["name"], desc: "replay a workflow deterministically" },
    "flow list": { ctl: "daemon.workflow_list", desc: "list workflows" },
  },
  verify: {
    "verify signer": { ctl: "daemon.verify_signer", desc: "verify a signing function offline against samples" },
    "verify replay": { ctl: "daemon.replay", desc: "TLS fingerprint replay (needs curl-impersonate)" },
    "verify evidence": { ctl: "daemon.evidence_write", desc: "write a record into the evidence archive" },
  },
  human: {
    handoff: { ctl: "handoff", desc: "hand the tab back to the human (captcha / QR login)" },
    "wait-user": { ctl: "wait_user", desc: "wait for the human to finish, then take over" },
  },
  daemon: {
    "daemon-status": { ctl: "daemon.status", desc: "daemon status (mode / relay / work directory)" },
    "reload-ext": { ctl: "reload_extension", desc: "make the extension reload itself (after editing extension code)" },
  },
};

// 扁平索引：'tab list' / 'open' → spec；最长匹配优先（两词命令先试两词）
const COMMANDS = new Map();
for (const group of Object.values(GROUPS)) {
  for (const [name, spec] of Object.entries(group)) COMMANDS.set(name, spec);
}

// ---------------------------------------------------------------------------
// ctl 客户端（与旧 mcp_server 同款薄封装）
// ---------------------------------------------------------------------------

class CtlClient {
  constructor() {
    this.ws = null;
    this.pending = new Map();
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
    const cid = `cli-${++this.counter}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(cid);
        reject(new Error("ctl call timeout"));
      }, (timeout + 10) * 1000);
      this.pending.set(cid, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ type: "call", id: cid, name, args, timeout }));
    });
  }

  close() {
    if (this.ws) try { this.ws.close(); } catch (e) {}
  }
}

// ---------------------------------------------------------------------------
// daemon 自动拉起：连不上 → spawn 分离子进程 → 等端口就绪
// ---------------------------------------------------------------------------

async function autostartDaemon() {
  const serverPath = path.join(__dirname, "server.js");
  process.stderr.write(`[owb] daemon not running, starting it (${CTL_URL})…\n`);
  spawn(process.execPath, [serverPath], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  }).unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const up = await new Promise((resolve) => {
      const ws = new WebSocket(CTL_URL);
      ws.once("open", () => { ws.close(); resolve(true); });
      ws.once("error", () => resolve(false));
    });
    if (up) return true;
  }
  return false;
}

// 扩展的 MV3 service worker 会被浏览器回收，WS 随之断开；扩展侧靠 30s 周期的
// alarm 唤醒重连。这个空窗里的调用会拿到 NO_EXTENSION / DISCONNECTED——
// 217 站连续跑动中实测掉线 6 次，直接打掉 2 个站点的结果。
// 掉线是瞬时且能自愈的，在 CLI 这一层透明重试即可：daemon 侧「立即失败」的
// 语义不动（测试依赖它），AI 也不必自己写重试逻辑。
const TRANSIENT_EXT_ERRORS = new Set(["NO_EXTENSION", "DISCONNECTED"]);
// UX: 退避总计约 35 秒。绝大多数情况下这是对的（掉线能自愈，值得等）。
// 但有两种场景明知道扩展不会回来，等满 35 秒纯属浪费：
// 自动化测试（要断言"参数被正确接收"，NO_EXTENSION 本身就是可接受的结果），
// 以及用户明确知道浏览器没开着的时候。给一个环境变量逃生口。
const EXT_RETRY_DELAYS_MS =
  process.env.OWB_NO_EXT_RETRY && process.env.OWB_NO_EXT_RETRY !== "0"
    ? []
    : [1500, 4000, 10000, 20000];

async function callWithAutostart(ctl, name, args, timeout, autostart) {
  let res;
  try {
    res = await ctl.call(name, args, timeout);
  } catch (e) {
    const refused = /ECONNREFUSED|ctl disconnected/.test(String(e && e.message));
    if (!refused || !autostart) throw e;
    if (!(await autostartDaemon())) {
      throw new Error(`failed to start the daemon: run node ${path.join("owb-daemon", "src", "server.js")} manually to see the error`);
    }
    res = await ctl.call(name, args, timeout);
  }
  for (const delay of EXT_RETRY_DELAYS_MS) {
    if (res.ok || !res.error || !TRANSIENT_EXT_ERRORS.has(res.error.code)) break;
    process.stderr.write(
      `[owb] extension unreachable (${res.error.code}), retrying in ${delay / 1000}s…\n`,
    );
    await new Promise((r) => setTimeout(r, delay));
    res = await ctl.call(name, args, timeout);
  }
  return res;
}

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

// BUG-115: 这些参数在语义上永远是字符串，绝不能被 JSON 自动解析。
// 起因：CDP 的 requestId 长得像小数（"110404.81"），`--request-id 110404.81`
// 被解析成数字 110404.81，而 buffer 是按字符串键存的 → `net detail` 对
// **每一条**请求都报 NOT_FOUND，整条 `net list → net detail` 下钻路径失效。
// 同类还有：scriptId 是纯数字串、`--text 404`、`--url-pattern 2024`——
// 一旦被转成数字，比对/正则全部走空。
const STRING_PARAMS = new Set([
  "request_id", "script_id", "object_id", "frame_id", "node_id",
  "text", "query", "selector", "url_pattern", "url_substring",
  "function_path", "expression", "code", "replacement", "hook_code",
  "name", "title", "filename", "path", "keys", "reason", "label",
  "condition", "mode", "format", "sort_by", "impersonate", "url",
  "source", "signer_code", "trigger", "patch_type", "position",
]);

function parseValue(v, key) {
  if (v === undefined) return true; // 裸 flag = true
  if (key && STRING_PARAMS.has(key)) return v; // 语义字符串，原样传
  try {
    return JSON.parse(v);
  } catch (e) {
    return v; // 非 JSON → 原样字符串
  }
}

function parseArgv(argv) {
  // 返回 { positionals, args, cli: {timeout, raw, compact, autostart} }
  const positionals = [];
  const args = {};
  const cli = { timeout: CALL_TIMEOUT_S, raw: false, compact: false, autostart: true, rawArgs: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      positionals.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    let key = eq >= 0 ? a.slice(2, eq) : a.slice(2);
    let val = eq >= 0 ? a.slice(eq + 1) : undefined;
    if (val === undefined && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      val = argv[++i];
    }
    switch (key) {
      case "timeout": cli.timeout = Number(val); continue;
      case "raw": cli.raw = true; if (val !== undefined && eq < 0) { positionals.push(val); } continue;
      case "compact": cli.compact = true; if (val !== undefined && eq < 0) { positionals.push(val); } continue;
      case "no-autostart": cli.autostart = false; if (val !== undefined && eq < 0) { positionals.push(val); } continue;
      case "args": cli.rawArgs = val; continue;
      case "out": cli.out = val; continue;   // 二进制结果落盘路径
      case "tab": args.tabId = parseValue(val); continue;
    }
    const name = key.replace(/-/g, "_");
    args[name] = parseValue(val, name);
  }
  return { positionals, args, cli };
}

function applyPositionals(spec, positionals, args) {
  const pos = spec.pos || [];
  for (let i = 0; i < positionals.length && i < pos.length; i++) {
    const p = pos[i];
    const v = positionals[i];
    if (p === TARGET || (p && p.target)) {
      if (String(v).startsWith("@")) args.ref = v;
      else args.selector = v;
    } else {
      args[p] = v;
    }
  }
  if (positionals.length > pos.length) {
    throw new UsageError(`too many positional arguments: ${positionals.slice(pos.length).join(" ")}`);
  }
}

class UsageError extends Error {}

// ---------------------------------------------------------------------------
// 输出整形：CLI 的读者是 AI 的上下文窗口，不是磁盘
// ---------------------------------------------------------------------------

// 二进制结果（截图 473KB base64、PDF 更大）直接打到 stdout 会一次性吃掉
// AI 的整个上下文窗口，且 base64 对它毫无可读价值。落盘 + 只回路径。
const BINARY_TOOLS = {
  screenshot: { field: "data", ext: (d) => (d.format === "jpeg" ? "jpg" : "png") },
  print_pdf: { field: "data", ext: () => "pdf" },
};

// 任何工具的返回超过这个体量都先截断——宁可让 AI 多问一次，
// 也不要它一条命令就失去上下文。
const MAX_STDOUT_BYTES = 60000;

function saveBinary(toolName, data, cli) {
  const spec = BINARY_TOOLS[toolName];
  const buf = Buffer.from(data[spec.field], "base64");
  let out = cli.out;
  if (!out) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    out = path.join(process.cwd(), `owb-${toolName === "print_pdf" ? "pdf" : "shot"}-${stamp}.${spec.ext(data)}`);
  }
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, buf);
  const rest = { ...data };
  delete rest[spec.field];
  delete rest.dataLength;
  return { ...rest, savedTo: path.resolve(out), bytes: buf.length };
}

// 同一份内容被返回多次时，只留最可读的那一份。read_page 实测：
// lines(20KB) + text(lines 的别名，20KB) + nodes(结构化重复，66KB) = 108KB，
// 真实信息量只有 20KB。不去冗余就会触发下面的截断护栏，
// 而截断又偏偏砍掉最该保留的 lines —— 先瘦身再判大小，顺序很重要。
function dropRedundant(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  const out = { ...data };
  // BUG-82: record_stop 把整份 HAR 内联返回（实测 42 条请求 / 10MB body）。
  // 这东西对 AI 的 stdout 毫无用处，只会撑爆上下文——HAR 的正确去处是磁盘。
  // 摘掉并指路 har save。
  if (out.har && typeof out.har === "object") {
    const n = out.entries != null
      ? out.entries
      : ((out.har.log || {}).entries || []).length;
    delete out.har;
    out._harOmitted =
      `HAR body (${n} entries) not printed — it belongs on disk, not in stdout. ` +
      'Next time use "owb har save" instead of "har stop" (save includes stop).';
  }
  // ⚠️ 只删 nodes，**不要删 text 别名**。text 是扩展侧刻意加的统一字段
  // （三种模式正文分别叫 lines/content/text，别名让调用方不必按模式切字段）；
  // 删掉它等于撤销一个有意的可用性设计，还会悄悄打断依赖它的调用方 ——
  // 本轮就把自己的扫描脚本读成了「正文 0 字」，差点误判为提取功能回归。
  // nodes[].line 逐条重复 lines 的内容，ref/role/name 也都已在行里，才是真冗余。
  if (typeof out.lines === "string" && Array.isArray(out.nodes) && out.nodes.length) {
    out._nodesOmitted = out.nodes.length;
    delete out.nodes;
  }
  return out;
}

function shapeForAgent(toolName, data, cli) {
  if (!data || typeof data !== "object") return data;
  if (BINARY_TOOLS[toolName] && typeof data[BINARY_TOOLS[toolName].field] === "string") {
    return saveBinary(toolName, data, cli);
  }
  const slim = dropRedundant(data);
  const json = JSON.stringify(slim);
  if (json.length <= MAX_STDOUT_BYTES) return slim;
  // 仍然超限：从**最大**的字符串字段开始砍，并给它保留尽可能多的额度，
  // 而不是一刀切把每个长字段都砍到同一个小值。
  const out = { ...slim };
  const strFields = Object.entries(slim)
    .filter(([, v]) => typeof v === "string" && v.length > 2000)
    .sort((a, b) => b[1].length - a[1].length);
  const clipped = [];
  for (const [k, v] of strFields) {
    if (JSON.stringify(out).length <= MAX_STDOUT_BYTES) break;
    const others = JSON.stringify({ ...out, [k]: "" }).length;
    const budget = Math.max(2000, MAX_STDOUT_BYTES - others - 200);
    if (v.length > budget) {
      out[k] = v.slice(0, budget);
      clipped.push(`${k} (${v.length} → ${budget} chars)`);
    }
  }
  if (clipped.length) {
    out._clipped = clipped;
    out._hint =
      "Output was too large and got clipped. For everything: narrow the scope with --max-chars/--max-nodes, or use --raw for the full envelope.";
  }
  return out;
}

// ---------------------------------------------------------------------------
// setup / skill：安装引导（把「照 README 手动做」变成可执行命令，AI 也能照做）
// ---------------------------------------------------------------------------

// 包根：cli.js 在 <root>/owb-daemon/src/ 下
const PKG_ROOT = path.resolve(__dirname, "..", "..");
const EXT_DIR = path.join(PKG_ROOT, "owb-extension");
const SKILL_SRC = path.join(PKG_ROOT, "owb-skills", "owb");

// Chrome 应用商店地址：上架后填这里，setup 就会把商店作为首选路径
// （一键安装 + 自动更新，无需开发者模式）。留空则只引导本地加载。
const STORE_URL = "";

function skillTargets() {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return {
    global: home ? path.join(home, ".claude", "skills", "owb") : null,
    project: path.join(process.cwd(), ".claude", "skills", "owb"),
  };
}

// 装 skill 到 ~/.claude/skills/owb（--project 装到当前项目）
function installSkill(toProject) {
  if (!fs.existsSync(SKILL_SRC)) {
    process.stderr.write(`error SKILL_MISSING: no skill bundled in the package (${SKILL_SRC})\n`);
    process.exitCode = 1;
    return null;
  }
  const t = skillTargets();
  const dest = toProject ? t.project : t.global;
  if (!dest) {
    process.stderr.write("error NO_HOME: cannot locate a home directory; use --project\n");
    process.exitCode = 1;
    return null;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(SKILL_SRC, dest, { recursive: true });
  return dest;
}

function cmdSkill(sub, toProject) {
  if (sub === "path") {
    process.stdout.write(SKILL_SRC + "\n");
    return;
  }
  if (sub && sub !== "install") {
    throw new UsageError(`owb skill: unknown subcommand ${sub} (available: install / path)`);
  }
  const dest = installSkill(toProject);
  if (dest) process.stdout.write(`✓ skill installed to ${dest}\n  Start a new agent session for it to take effect.\n`);
}

// 安装引导：打印扩展路径 + 装 skill + 自检。人工步骤只有「Chrome 加载扩展」一步。
async function cmdSetup(ctl, autostart) {
  const out = process.stdout;
  out.write("Open Web Bridge setup\n\n");

  // 1. 扩展：必须装进用户自己的浏览器 profile（登录态就在那儿），无法命令行代劳
  const extOk = fs.existsSync(path.join(EXT_DIR, "manifest.json"));
  out.write("1. Install the browser extension (the one step you have to do yourself)\n");
  if (STORE_URL) {
    out.write(`   Recommended - one click from the store, auto-updating: ${STORE_URL}\n`);
    if (extOk) out.write(`   Or the bundled dev build: chrome://extensions -> Developer mode -> Load unpacked -> ${EXT_DIR}\n`);
  } else if (extOk) {
    out.write(`   Extension directory: ${EXT_DIR}\n`);
    out.write("   In the browser: chrome://extensions -> turn on Developer mode (top right)\n");
    out.write("   -> click Load unpacked -> pick the directory above\n");
  } else {
    out.write(`   ✗ extension directory not found (${EXT_DIR}) - the install may be incomplete\n`);
  }

  // 2. skill：可选但推荐
  out.write("\n2. Install the skill (teaches the agent how to use this; optional)\n");
  const t = skillTargets();
  const already = t.global && fs.existsSync(path.join(t.global, "SKILL.md"));
  if (already) {
    out.write(`   ✓ installed: ${t.global}\n`);
  } else {
    out.write("   Run: owb skill install            (installs to ~/.claude/skills/)\n");
    out.write("   Or:  owb skill install --project  (installs into the current project only)\n");
  }

  // 3. 连通性自检
  out.write("\n3. Self-check\n");
  await doctor(ctl, autostart);
}

// ---------------------------------------------------------------------------
// help / doctor
// ---------------------------------------------------------------------------

function printHelp(groupName) {
  const out = [];
  if (groupName && GROUPS[groupName]) {
    out.push(`owb ${groupName} commands:`);
    for (const [name, spec] of Object.entries(GROUPS[groupName])) {
      out.push(`  owb ${name.padEnd(22)} ${spec.desc}`);
    }
  } else {
    out.push("owb - let an AI agent drive your real browser");
    out.push("");
    out.push("  owb setup              setup walkthrough (run this first)");
    out.push("  owb                    self-check: daemon and extension connection");
    out.push("  owb skill install      install the skill into ~/.claude/skills/ (--project for this project only)");
    out.push("  owb help <group>       details for one group");
    out.push("  owb call <tool> --args '<json>'   call any underlying tool directly");
    out.push("");
    // BUG-120: 原来一律 `n.split(" ").pop()` 只取最后一段，于是「要带组名前缀的」
    // 和「顶层的」在这一行里长得一模一样。debug 组里 7 条要写 `owb debug xxx`、
    // 唯独 oracle 是 `owb oracle`；file 组正好相反（download/upload/pdf 是顶层、
    // 只有 fetch 要写 `owb file fetch`）。照着这行敲 `owb debug oracle`、
    // `owb file download`、`owb fetch` 全都报「未知命令」。
    // 组内前缀一致时照旧省略（组名本身就说明了前缀）；**混用的组打印完整命令**。
    for (const [gname, group] of Object.entries(GROUPS)) {
      const keys = Object.keys(group);
      const prefix = `${gname} `;
      const mixed =
        keys.some((k) => k.startsWith(prefix)) &&
        keys.some((k) => !k.startsWith(prefix));
      const names = mixed
        ? keys
        : keys.map((n) => (n.startsWith(prefix) ? n.slice(prefix.length) : n));
      out.push(`  [${gname}] ${[...new Set(names)].join(mixed ? " / " : " ")}`);
    }
    out.push("");
    out.push("Common flags: --tab <id> --timeout <s> --out <file> --raw --compact --no-autostart --args '<json>'");
  }
  process.stdout.write(out.join("\n") + "\n");
}

async function doctor(ctl, autostart) {
  let daemonRes;
  try {
    daemonRes = await callWithAutostart(ctl, "daemon.status", {}, 10, autostart);
  } catch (e) {
    process.stdout.write(`✗ daemon unreachable (${CTL_URL}): ${e.message}\n`);
    process.exitCode = 1;
    return;
  }
  const d = (daemonRes.ok && daemonRes.data) || {};
  process.stdout.write(`✓ daemon ${CTL_URL}${d.mode ? ` (${d.mode} mode)` : ""}\n`);
  const extRes = await ctl.call("status", {}, 15).catch(() => null);
  if (extRes && extRes.ok) {
    const tabs = (extRes.data && extRes.data.tabs) || [];
    process.stdout.write(`✓ extension connected, attached tabs: ${tabs.length}\n`);
    process.stdout.write(`Next: owb open <url> -> owb page -> owb click @eN\n`);
  } else {
    const msg = extRes && extRes.error ? extRes.error.message : "not connected";
    process.stdout.write(`✗ extension not connected (${msg})\n`);
    process.stdout.write(
      "  Check: is owb-extension/ loaded in the browser (chrome://extensions, Developer mode)?\n" +
      "  Click the extension icon in the toolbar to see its status, and Reconnect if needed.\n",
    );
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const { positionals, args, cli } = parseArgv(argv);

  if (positionals[0] === "help" || args.help === true) {
    printHelp(positionals[1]);
    return;
  }
  // skill 安装是纯本地文件操作，不连 ctl
  if (positionals[0] === "skill") {
    try {
      cmdSkill(positionals[1], args.project === true);
    } catch (e) {
      process.stderr.write(`usage error: ${e.message}\n`);
      process.exitCode = 2;
    }
    return;
  }

  const ctl = new CtlClient();
  try {
    if (positionals.length === 0) {
      await doctor(ctl, cli.autostart);
      return;
    }
    if (positionals[0] === "setup") {
      await cmdSetup(ctl, cli.autostart);
      return;
    }

    // 命令解析：先试两词（'tab list'），再试一词（'open'），再 call 直调
    let spec = null;
    let consumed = 0;
    const two = positionals.slice(0, 2).join(" ");
    if (COMMANDS.has(two)) { spec = COMMANDS.get(two); consumed = 2; }
    else if (COMMANDS.has(positionals[0])) { spec = COMMANDS.get(positionals[0]); consumed = 1; }
    else if (positionals[0] === "call" && positionals[1]) {
      spec = { ctl: positionals[1], pos: [] };
      consumed = 2;
    }
    if (!spec) {
      throw new UsageError(`unknown command: ${positionals[0]} (run owb help for the list)`);
    }

    const callArgs = { ...(spec.preset || {}) };
    applyPositionals(spec, positionals.slice(consumed), callArgs);
    Object.assign(callArgs, args);
    if (cli.rawArgs) {
      let extra;
      try {
        extra = JSON.parse(cli.rawArgs);
      } catch (e) {
        throw new UsageError(`--args is not valid JSON: ${e.message}`);
      }
      Object.assign(callArgs, extra);
    }
    // click --mouse → 换 mouse_click 工具（真实鼠标事件 + AI 光标动画）
    let ctlName = spec.ctl;
    if (ctlName === "click" && callArgs.mouse === true) {
      delete callArgs.mouse;
      ctlName = "mouse_click";
    }
    // wait_user 内部默认 280s 超过 CLI 默认 120s：未显式给 --timeout 时自动放宽
    let timeout = cli.timeout;
    if (ctlName === "wait_user" && cli.timeout === CALL_TIMEOUT_S) {
      timeout = Math.ceil((Number(callArgs.timeout_ms) || 280000) / 1000) + 10;
    }

    const res = await callWithAutostart(ctl, ctlName, callArgs, timeout, cli.autostart);
    if (cli.raw) {
      process.stdout.write(JSON.stringify(res, null, cli.compact ? 0 : 2) + "\n");
      if (!res.ok) process.exitCode = 1;
      return;
    }
    if (res.ok) {
      const shaped = shapeForAgent(ctlName, res.data, cli);
      process.stdout.write(JSON.stringify(shaped ?? null, null, cli.compact ? 0 : 2) + "\n");
    } else {
      const err = res.error || {};
      let line = `error ${err.code || "INTERNAL"}: ${err.message !== undefined ? err.message : err}`;
      if (err.retryable) line += " (retryable)";
      process.stderr.write(line + "\n");
      process.exitCode = 1;
    }
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`usage error: ${e.message}\n`);
      process.exitCode = 2;
    } else {
      process.stderr.write(`error CTL_UNREACHABLE: ${e.message}\n`);
      process.exitCode = 1;
    }
  } finally {
    ctl.close();
  }
}

if (isMainModule(import.meta.url)) {
  main();
}

export { GROUPS, COMMANDS, parseArgv };

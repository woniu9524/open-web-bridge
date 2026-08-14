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
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
  基础: {
    open: { ctl: "navigate", pos: ["url"], desc: "打开 url（--new-tab 新开 tab）" },
    back: { ctl: "history", preset: { action: "back" }, desc: "后退" },
    forward: { ctl: "history", preset: { action: "forward" }, desc: "前进" },
    reload: { ctl: "history", preset: { action: "reload" }, desc: "刷新（--bypass-cache 强刷）" },
    page: { ctl: "read_page", desc: "语义快照（@eN ref 供 click/fill）；--mode article|text，--since-last 增量" },
    shot: { ctl: "screenshot", desc: "截图" },
    click: { ctl: "click", pos: [TARGET], desc: "点击 @ref 或 selector（--mouse 走真实鼠标事件）" },
    "click-mouse": { ctl: "mouse_click", pos: [TARGET], desc: "真实鼠标事件点击（isTrusted，带 AI 光标动画）" },
    fill: { ctl: "fill", pos: [TARGET, "value"], desc: "填输入框（native setter，兼容 React 受控组件）" },
    keys: { ctl: "send_keys", desc: "键盘输入：--text 走 insertText，--keys 走真实按键（二选一）" },
    scroll: { ctl: "scroll", desc: "滚动页面" },
    eval: { ctl: "evaluate", pos: ["expression"], desc: "页面上下文执行 JS 表达式" },
    wait: { ctl: "wait_for", desc: "等待 --selector / --text / --url-pattern / --network-idle" },
    frames: { ctl: "list_frames", desc: "列出 iframe（配合 eval --frame-pattern）" },
    status: { ctl: "status", desc: "扩展侧状态：WS 连接、attached tabs" },
    cdp: { ctl: "cdp", desc: "直发任意 CDP 命令（逃生口）" },
  },
  tab: {
    "tab list": { ctl: "list_tabs", desc: "列出全部 tab" },
    "tab find": { ctl: "find_tab", pos: ["url_pattern"], desc: "按 url 正则找 tab" },
    "tab close": { ctl: "close_tab", desc: "关 tab（--tab 指定）" },
    "tab close-group": { ctl: "close_group", desc: "关掉「OWB 分析」组全部 tab" },
  },
  net: {
    "net start": { ctl: "network_start", desc: "开始抓包" },
    "net stop": { ctl: "network_stop", desc: "停止抓包" },
    "net list": { ctl: "network_list", desc: "列出已捕获请求（可过滤）" },
    "net detail": { ctl: "network_detail", desc: "单条请求全量（头 + body）" },
    "net initiator": { ctl: "get_initiator", desc: "请求发起调用栈" },
    "net capture": { ctl: "capture_request", desc: "宏工具：触发动作并捕获目标请求" },
  },
  har: {
    "har start": { ctl: "record_start", desc: "开始录制（HAR 1.2 全量）" },
    "har stop": { ctl: "record_stop", desc: "停止录制" },
    "har status": { ctl: "record_status", desc: "录制状态" },
    "har save": { ctl: "daemon.har_save", desc: "录制结果落盘为 HAR 文件" },
    "har to-replay": { ctl: "daemon.har_to_replay", desc: "HAR → python/curl/node 重放脚本" },
    "har diff": { ctl: "daemon.har_diff", desc: "两份 HAR 对比漂移" },
    "har assert": { ctl: "daemon.har_assert", desc: "HAR 断言校验" },
  },
  hook: {
    "hook preset": { ctl: "hook_preset", pos: ["preset"], desc: "注入预设 hook：xhr|fetch|crypto" },
    "hook fn": { ctl: "hook_function", desc: "hook 任意函数记录出入参" },
    "hook remove": { ctl: "hook_remove", desc: "移除 hook" },
    "hook status": { ctl: "hook_status", desc: "hook 注入状态" },
    "hook logs": { ctl: "daemon.hook_logs", desc: "拉取 hook 事件（轮询）" },
  },
  debug: {
    "debug break-xhr": { ctl: "break_xhr", desc: "XHR 断点（配 debug frames 读冻结现场）" },
    "debug break-fn": { ctl: "break_function", desc: "函数断点" },
    "debug break-remove": { ctl: "break_remove", desc: "移除断点" },
    "debug frames": { ctl: "frame_read", desc: "读断点调用帧（frozen snapshot，自动 resume）" },
    "debug step": { ctl: "step", desc: "单步" },
    "debug resume": { ctl: "resume", desc: "恢复执行" },
    "debug console": { ctl: "console_stream", desc: "console 输出流" },
    oracle: { ctl: "oracle_call", desc: "对页面函数做确定性采样调用" },
  },
  script: {
    "script list": { ctl: "script_list", desc: "列出页面脚本" },
    "script source": { ctl: "script_source", desc: "取脚本源码" },
    "script search": { ctl: "search_code", desc: "全脚本代码搜索" },
    "script patch": { ctl: "script_patch", desc: "改写脚本（下次加载生效）" },
    "script unpatch": { ctl: "script_unpatch", desc: "撤销改写" },
    "script watch": { ctl: "watch_script", desc: "监听脚本加载" },
    "script watch-remove": { ctl: "watch_remove", desc: "移除监听" },
  },
  cookie: {
    "cookie get": { ctl: "cookie_get", desc: "读 cookie" },
    "cookie set": { ctl: "cookie_set", desc: "写 cookie" },
    "cookie delete": { ctl: "cookie_delete", desc: "删 cookie" },
  },
  state: {
    "state save": { ctl: "daemon.state_save", pos: ["name"], desc: "保存站点登录态（cookie+storage+IDB）" },
    "state load": { ctl: "daemon.state_load", pos: ["name"], desc: "恢复登录态" },
    "state list": { ctl: "daemon.state_list", desc: "列出已存登录态" },
    "state delete": { ctl: "daemon.state_delete", pos: ["name"], desc: "删除登录态" },
    "state export": { ctl: "export_state", desc: "导出当前页 storage（扩展侧原语）" },
    "state import": { ctl: "import_state", desc: "导入 storage（扩展侧原语）" },
  },
  env: {
    "env set": { ctl: "emulate", desc: "环境模拟：设备/网络节流/地理/时区/语言/UA" },
    "env reset": { ctl: "emulate_reset", desc: "恢复真实环境" },
    "env compare": { ctl: "env_compare", desc: "模拟前后环境对比" },
  },
  file: {
    download: { ctl: "download", desc: "下载页面资源" },
    upload: { ctl: "upload", desc: "上传文件到页面（DataTransfer，无需文件系统）" },
    pdf: { ctl: "print_pdf", desc: "导出页面为 PDF" },
    "file fetch": { ctl: "daemon.download", desc: "daemon 侧直接下载 URL" },
  },
  task: {
    "task begin": { ctl: "daemon.task_begin", pos: ["name"], desc: "任务开始（归档 + 标签）" },
    "task end": { ctl: "daemon.task_end", desc: "任务结束（自动收尾 HAR 入档）" },
    "task list": { ctl: "daemon.task_list", desc: "任务列表" },
  },
  flow: {
    "flow save": { ctl: "daemon.workflow_save", pos: ["name"], desc: "把跑通的流程固化为工作流" },
    "flow run": { ctl: "daemon.workflow_run", pos: ["name"], desc: "确定性回放工作流" },
    "flow list": { ctl: "daemon.workflow_list", desc: "工作流列表" },
  },
  verify: {
    "verify signer": { ctl: "daemon.verify_signer", desc: "离线验证签名函数" },
    "verify replay": { ctl: "daemon.replay", desc: "TLS 指纹重放（需 curl-impersonate）" },
    "verify evidence": { ctl: "daemon.evidence_write", desc: "写入取证记录" },
  },
  human: {
    handoff: { ctl: "handoff", desc: "把 tab 交还人类（验证码/扫码登录）" },
    "wait-user": { ctl: "wait_user", desc: "等人类操作完成后接管" },
  },
  daemon: {
    "daemon-status": { ctl: "daemon.status", desc: "daemon 状态（模式/中转/工作目录）" },
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
  process.stderr.write(`[owb] daemon 未运行，自动拉起（${CTL_URL}）…\n`);
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

async function callWithAutostart(ctl, name, args, timeout, autostart) {
  try {
    return await ctl.call(name, args, timeout);
  } catch (e) {
    const refused = /ECONNREFUSED|ctl disconnected/.test(String(e && e.message));
    if (!refused || !autostart) throw e;
    if (!(await autostartDaemon())) {
      throw new Error(`daemon 拉起失败：手动运行 node ${path.join("owb-daemon", "src", "server.js")} 看报错`);
    }
    return ctl.call(name, args, timeout);
  }
}

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

function parseValue(v) {
  if (v === undefined) return true; // 裸 flag = true
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
      case "tab": args.tabId = parseValue(val); continue;
    }
    args[key.replace(/-/g, "_")] = parseValue(val);
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
    throw new UsageError(`多余的位置参数：${positionals.slice(pos.length).join(" ")}`);
  }
}

class UsageError extends Error {}

// ---------------------------------------------------------------------------
// help / doctor
// ---------------------------------------------------------------------------

function printHelp(groupName) {
  const out = [];
  if (groupName && GROUPS[groupName]) {
    out.push(`owb ${groupName} 组命令：`);
    for (const [name, spec] of Object.entries(GROUPS[groupName])) {
      out.push(`  owb ${name.padEnd(22)} ${spec.desc}`);
    }
  } else {
    out.push("owb — 让 AI agent 驱动你的真实浏览器（详细流程见 skill：owb-skills/owb/SKILL.md）");
    out.push("");
    out.push("  owb                    自检：daemon/扩展连接状态");
    out.push("  owb help <组>          组内命令详情");
    out.push("  owb call <工具> --args '<json>'   直调任意 ctl 工具");
    out.push("");
    for (const [gname, group] of Object.entries(GROUPS)) {
      const names = Object.keys(group).map((n) => n.split(" ").pop());
      out.push(`  [${gname}] ${[...new Set(names)].join(" ")}`);
    }
    out.push("");
    out.push("通用 flag：--tab <id> --timeout <s> --raw --compact --no-autostart --args '<json>'");
  }
  process.stdout.write(out.join("\n") + "\n");
}

async function doctor(ctl, autostart) {
  let daemonRes;
  try {
    daemonRes = await callWithAutostart(ctl, "daemon.status", {}, 10, autostart);
  } catch (e) {
    process.stdout.write(`✗ daemon 不可达（${CTL_URL}）：${e.message}\n`);
    process.exitCode = 1;
    return;
  }
  const d = (daemonRes.ok && daemonRes.data) || {};
  process.stdout.write(`✓ daemon ${CTL_URL}${d.mode ? `（${d.mode} 模式）` : ""}\n`);
  const extRes = await ctl.call("status", {}, 15).catch(() => null);
  if (extRes && extRes.ok) {
    const tabs = (extRes.data && extRes.data.tabs) || [];
    process.stdout.write(`✓ 扩展已连接，attached tabs: ${tabs.length}\n`);
    process.stdout.write(`下一步：owb open <url> → owb page → owb click @eN\n`);
  } else {
    const msg = extRes && extRes.error ? extRes.error.message : "未连接";
    process.stdout.write(`✗ 扩展未连接（${msg}）\n`);
    process.stdout.write(
      "  检查：浏览器已加载 owb-extension/ 目录（chrome://extensions 开发者模式）？\n" +
      "  点扩展工具栏图标看连接状态，必要时「重新连接」。\n",
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

  const ctl = new CtlClient();
  try {
    if (positionals.length === 0) {
      await doctor(ctl, cli.autostart);
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
      throw new UsageError(`未知命令：${positionals[0]}（owb help 看清单）`);
    }

    const callArgs = { ...(spec.preset || {}) };
    applyPositionals(spec, positionals.slice(consumed), callArgs);
    Object.assign(callArgs, args);
    if (cli.rawArgs) {
      let extra;
      try {
        extra = JSON.parse(cli.rawArgs);
      } catch (e) {
        throw new UsageError(`--args 不是合法 JSON：${e.message}`);
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
      process.stdout.write(JSON.stringify(res.data ?? null, null, cli.compact ? 0 : 2) + "\n");
    } else {
      const err = res.error || {};
      let line = `error ${err.code || "INTERNAL"}: ${err.message !== undefined ? err.message : err}`;
      if (err.retryable) line += "（可重试）";
      process.stderr.write(line + "\n");
      process.exitCode = 1;
    }
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`用法错误：${e.message}\n`);
      process.exitCode = 2;
    } else {
      process.stderr.write(`error CTL_UNREACHABLE: ${e.message}\n`);
      process.exitCode = 1;
    }
  } finally {
    ctl.close();
  }
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main();
}

export { GROUPS, COMMANDS, parseArgv };

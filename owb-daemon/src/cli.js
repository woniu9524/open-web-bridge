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
    "reload-ext": { ctl: "reload_extension", desc: "让扩展重载自己（改完扩展代码用，免去手点 chrome://extensions）" },
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
      case "out": cli.out = val; continue;   // 二进制结果落盘路径
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

function shapeForAgent(toolName, data, cli) {
  if (!data || typeof data !== "object") return data;
  if (BINARY_TOOLS[toolName] && typeof data[BINARY_TOOLS[toolName].field] === "string") {
    return saveBinary(toolName, data, cli);
  }
  const json = JSON.stringify(data);
  if (json.length <= MAX_STDOUT_BYTES) return data;
  // 超限：保留结构，把最长的字符串字段截掉并说明怎么拿全量
  const out = {};
  let clipped = null;
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === "string" && v.length > 4000) {
      out[k] = v.slice(0, 4000);
      clipped = clipped || [];
      clipped.push(`${k} (${v.length} chars → 4000)`);
    } else {
      out[k] = v;
    }
  }
  if (clipped) {
    out._clipped = clipped;
    out._hint =
      "输出过大已截断。要全量：加 --out <文件> 落盘，或用 --max-chars/--max-nodes 缩小范围，" +
      "或 --raw 拿原始信封自行处理。";
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
    process.stderr.write(`error SKILL_MISSING: 包内找不到 skill（${SKILL_SRC}）\n`);
    process.exitCode = 1;
    return null;
  }
  const t = skillTargets();
  const dest = toProject ? t.project : t.global;
  if (!dest) {
    process.stderr.write("error NO_HOME: 无法定位 home 目录，请用 --project\n");
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
    throw new UsageError(`owb skill: 未知子命令 ${sub}（可用：install / path）`);
  }
  const dest = installSkill(toProject);
  if (dest) process.stdout.write(`✓ skill 已装到 ${dest}\n  重开 agent 会话即可生效。\n`);
}

// 安装引导：打印扩展路径 + 装 skill + 自检。人工步骤只有「Chrome 加载扩展」一步。
async function cmdSetup(ctl, autostart) {
  const out = process.stdout;
  out.write("Open Web Bridge 安装引导\n\n");

  // 1. 扩展：必须装进用户自己的浏览器 profile（登录态就在那儿），无法命令行代劳
  const extOk = fs.existsSync(path.join(EXT_DIR, "manifest.json"));
  out.write("① 装浏览器扩展（唯一需要你手动做的一步）\n");
  if (STORE_URL) {
    out.write(`   推荐 · 应用商店一键装（自动更新）：${STORE_URL}\n`);
    if (extOk) out.write(`   或用随包的开发版：chrome://extensions → 开发者模式 → 加载已解压 → ${EXT_DIR}\n`);
  } else if (extOk) {
    out.write(`   扩展目录：${EXT_DIR}\n`);
    out.write("   在浏览器里：chrome://extensions → 打开右上角「开发者模式」\n");
    out.write("   → 点「加载已解压的扩展程序」→ 选上面那个目录\n");
  } else {
    out.write(`   ✗ 找不到扩展目录（${EXT_DIR}）——安装可能不完整\n`);
  }

  // 2. skill：可选但推荐
  out.write("\n② 装 skill（让 AI agent 知道怎么用，可选）\n");
  const t = skillTargets();
  const already = t.global && fs.existsSync(path.join(t.global, "SKILL.md"));
  if (already) {
    out.write(`   ✓ 已装：${t.global}\n`);
  } else {
    out.write("   运行：owb skill install          （装到 ~/.claude/skills/）\n");
    out.write("   或：  owb skill install --project（只装到当前项目）\n");
  }

  // 3. 连通性自检
  out.write("\n③ 自检\n");
  await doctor(ctl, autostart);
}

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
    out.push("owb — 让 AI agent 驱动你的真实浏览器");
    out.push("");
    out.push("  owb setup              安装引导（装完先跑这个）");
    out.push("  owb                    自检：daemon/扩展连接状态");
    out.push("  owb skill install      把 skill 装进 ~/.claude/skills/（--project 装到当前项目）");
    out.push("  owb help <组>          组内命令详情");
    out.push("  owb call <工具> --args '<json>'   直调任意 ctl 工具");
    out.push("");
    for (const [gname, group] of Object.entries(GROUPS)) {
      const names = Object.keys(group).map((n) => n.split(" ").pop());
      out.push(`  [${gname}] ${[...new Set(names)].join(" ")}`);
    }
    out.push("");
    out.push("通用 flag：--tab <id> --timeout <s> --out <文件> --raw --compact --no-autostart --args '<json>'");
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
  // skill 安装是纯本地文件操作，不连 ctl
  if (positionals[0] === "skill") {
    try {
      cmdSkill(positionals[1], args.project === true);
    } catch (e) {
      process.stderr.write(`用法错误：${e.message}\n`);
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
      const shaped = shapeForAgent(ctlName, res.data, cli);
      process.stdout.write(JSON.stringify(shaped ?? null, null, cli.compact ? 0 : 2) + "\n");
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

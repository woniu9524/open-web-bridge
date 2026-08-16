#!/usr/bin/env node
/**
 * Open Web Bridge daemon — WS server。
 *
 * 拓扑（默认端口 43917——高位冷门端口，避免与常见开发端口/其他工具撞车；
 * 曾用 18086，10086 与 kimi-webbridge 默认端口冲突）：
 *   扩展  → ws://127.0.0.1:43917/ws   （hello 握手，Host/Origin 校验防 DNS rebinding）
 *   控制器 → ws://127.0.0.1:43917/ctl  （call / subscribe / events 补拉）
 *
 * 仅绑定 127.0.0.1。本地信任模型：无 token 认证（同机任意进程可连），
 * Host/Origin 校验防网页 DNS rebinding。
 *
 * 端口可用环境变量 OWB_PORT 覆盖（e2e 与日常浏览器隔离用；
 * 单扩展模型下两个浏览器实例会在同一端口上互相顶替）。
 *
 * agent/人的接入面是 cli.js（owb 命令，薄转发到 ctl）；
 * client.js 是更底层的 ctl/事件流调试 CLI。
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";

import { isMainModule } from "./ismain.js";

import { EvidenceStore, RollingJsonl, ymd } from "./evidence.js";
import { verify_signer, dry_run_signer } from "./verify.js";
import { replay } from "./replay.js";
import { harToReplay, harDiff, harAssert } from "./harexport.js";

export const HOST = "127.0.0.1";
export const PORT = parseInt(process.env.OWB_PORT || "43917", 10);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// work/ 目录可用 OWB_WORK_DIR 覆盖（e2e 与日常浏览器隔离用），默认行为不变
export const WORK_DIR = process.env.OWB_WORK_DIR || path.join(REPO_ROOT, "work");

const ALLOWED_HOSTS = new Set([`${HOST}:${PORT}`, `localhost:${PORT}`]);
const EVENT_BUFFER_SIZE = 2000;

function envInt(name, dflt) {
  const v = parseInt(process.env[name] || "", 10);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}

// ---- 磁盘日志闸门 ----
// events.jsonl 默认**不写**：补拉走内存 ring buffer（events 与 hook_logs 两个
// 消费者读的都是 event_buffer），磁盘上那份从来没有任何代码读回 —— 纯只写死重，
// 实测在开发机上长到 18 GiB。需要跨重启的磁盘取证再用 OWB_EVENTS_LOG=1 打开，
// 那条路径同样带按天切分 + 大小上限 + 过期清理。
const EVENTS_LOG_ENABLED =
  !!process.env.OWB_EVENTS_LOG && process.env.OWB_EVENTS_LOG !== "0";
const LOG_KEEP_DAYS = envInt("OWB_LOG_KEEP_DAYS", 14);      // 0 = 不清理
const LOG_MAX_FILE_BYTES = envInt("OWB_LOG_MAX_FILE_MB", 64) * 1024 * 1024;
const PING_INTERVAL_S = 20;
// hello.payload.client 须为此值（协议族识别，见 handleExtension 注释）
const EXTENSION_CLIENT = "open-web-bridge-extension";
// 大 tool_result（响应体/截图 base64）走 JSON 文本帧，默认 1MiB 会掐断连接
const MAX_PAYLOAD = 64 * 1024 * 1024;

// 中转模式（默认关闭）：OWB_RELAY_URL + OWB_RELAY_TOKEN 两者齐备即启用。
// daemon 拨出到中转，与扩展按 token 配对；不设则本地模式（127.0.0.1 无 token）。
export const OWB_RELAY_URL = process.env.OWB_RELAY_URL || "";
export const OWB_RELAY_TOKEN = process.env.OWB_RELAY_TOKEN || "";

// UX-85: call_local 支持的 daemon 侧工具名（call_tool 用它给不带前缀的调用
// 报出可操作的错误）。EXT_ONLY_OVERLAP 是两侧同名的工具——不带前缀时按老规矩
// 转发给扩展，语义不变。
const DAEMON_LOCAL_TOOLS = new Set([
  "status", "shutdown", "hook_logs", "verify_signer", "replay", "evidence_write",
  "task_begin", "task_end", "task_list", "workflow_save", "workflow_run",
  "workflow_list", "state_save", "state_load", "state_list", "state_delete",
  "har_save", "download", "har_to_replay", "har_diff", "har_assert",
]);
const EXT_ONLY_OVERLAP = new Set(["status", "download"]);

/**
 * UX-204: HAR 工具的 har 参数收到 JSON 字符串时会一路走到 har.log.entries →
 * undefined → entries=[]，断言全过、diff 全空 —— 静默的假成功。这里统一把
 * 字符串解析回对象，解析不了就明确报错。
 */
function coerceHar(v, label = "har") {
  if (v && typeof v === "object") return v;
  if (typeof v === "string") {
    const s = v.trim();
    if (!s.startsWith("{")) return null; // 交给调用方按 path 处理
    try {
      return JSON.parse(s);
    } catch (e) {
      const err = new Error(
        `${label}: value looks like JSON but failed to parse (${e.message})`,
      );
      err.owbCode = "BAD_HAR";
      throw err;
    }
  }
  return null;
}

// ---- 安全（Host + Origin 校验防 DNS rebinding / CSRF）----
// 本地信任模型：仅绑定 127.0.0.1，不做 token 认证（同机任意进程可连）。
// Host/Origin 是两层防线中的第二层：防网页经 DNS rebinding 打本机 daemon。

// --- 小工具 -----------------------------------------------------------------

/** 工作流/会话库文件名 slug：小写、非字母数字转 -、截 40。 */
// BUG-119: 原来是 `[^a-z0-9]+ → "-"`，把所有非 ASCII 字符全抹掉，于是**纯中文
// 名字会塌成空串**。后果是 SKILL.md 里自己写的例子就跑不通：
//   owb flow save 周报   → BAD_ARGS: workflow_save: name is required
// ——明明给了名字，却说没给。state / har 文件名 / replay 文件名同一条路径。
// 这个仓库的文档和用户都是中文的，等于所有自然写法都失效。
// 改成只保留 Unicode 字母/数字（CJK、带重音的拉丁、西里尔都算），
// 其余（空格、标点、路径分隔符、控制字符）一律折成连字符——
// 现代文件系统存中文文件名没有任何问题。
export function _slug(name) {
  const raw = String(name || "").trim();
  // BUG-5: preserve trailing extension (e.g. .har) so "my_analysis.har"
  // doesn't become "my-analysis-har.har" with double extension.
  const extMatch = raw.match(/\.([A-Za-z0-9]{1,8})$/);
  const ext = extMatch ? extMatch[0].toLowerCase() : "";
  const base = (ext ? raw.slice(0, -ext.length) : raw)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, ""); // 截断可能正好切在连字符上
  return base + (base && ext ? ext : "");
}

const pad2 = (n) => String(n).padStart(2, "0");
// ymd 从 evidence.js 导入：磁盘上按天切分的文件名以那边为准，
// 两处各写一份 YYYYMMDD 格式化必然漂移。

/** 返回 YYYYMMDD-HHMMSS（本地时区）。 */
function tsId(d = new Date()) {
  return `${ymd(d)}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

/** 返回 YYYY-MM-DDTHH:MM:SS（本地时区，无 tz 后缀）。 */
function isoSeconds(d = new Date()) {
  return `${ymd(d).replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3")}` +
    `T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// ---- 审计脱敏 / 体积上限 ----
//
// 审计日志要回答的是「谁在什么时候调了什么」，不是留一份载荷副本。原来 _audit
// 把 payload 原样写盘，同时踩了两个坑：
//   体积 —— 截图是 base64、read_page 是整页正文、network_detail 带响应体，
//           实测单行到过 4.4 MB、单日文件 130 MB；
//   凭据 —— export_state 的 cookie（含 HttpOnly）、cookie_get 的结果原样入库，
//           等于在 work/ 下又开了一个凭据库，而文档只告诉用户 states/ 敏感。
//
// 按**方向**分治，因为两个方向的读者根本不同：
//   tool_result（两个方向）—— 没有任何代码读回，狠裁：深度抹凭据键 + 总量上限；
//   tool_call 的 args      —— workflow_save 要靠它重建可回放步骤（见该分支的
//                             `dir === "ext->"` 过滤），必须保真，只抹掉
//                             import_state 那种「整包凭据」参数。
const REDACT_KEYS = new Set([
  "cookies", "storage", "state", "password", "passwd",
  "token", "secret", "authorization", "relayToken",
]);
const AUDIT_RESULT_MAX_BYTES = 2048;

function redactedLabel(v) {
  if (typeof v === "string") return `[redacted ${v.length} chars]`;
  if (Array.isArray(v)) return `[redacted ${v.length} items]`;
  if (v && typeof v === "object") return `[redacted ${Object.keys(v).length} keys]`;
  return "[redacted]";
}

/** 深度抹掉凭据键。只用于 tool_result —— 没有代码读回它们。 */
function redactDeep(node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 6) return node;
  if (Array.isArray(node)) return node.map((x) => redactDeep(x, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    out[k] = REDACT_KEYS.has(k) ? redactedLabel(v) : redactDeep(v, depth + 1);
  }
  return out;
}

/** 落盘前处理一条审计记录。脱敏本身绝不能让 daemon 挂掉，故整体兜底。 */
export function auditSafe(entry) {
  try {
    const e = { ...entry };
    const p = e.payload;
    if (!p || typeof p !== "object") return e;
    if (e.type === "tool_call") {
      // args 是回放源，保持原样；只处理整包凭据参数
      if (p.args && typeof p.args === "object" && p.args.state !== undefined) {
        e.payload = { ...p, args: { ...p.args, state: redactedLabel(p.args.state) } };
      }
      return e;
    }
    const slim = redactDeep(p);
    const s = JSON.stringify(slim);
    e.payload = s && s.length > AUDIT_RESULT_MAX_BYTES
      ? { _omitted: `result payload ${s.length} B exceeded the ` +
                    `${AUDIT_RESULT_MAX_BYTES} B audit cap`,
          _keys: Object.keys(slim).slice(0, 20) }
      : slim;
    return e;
  } catch (err) {
    return { ts: entry && entry.ts, dir: entry && entry.dir,
             type: entry && entry.type, _auditError: String(err) };
  }
}

/** 订阅过滤匹配。 */
function subMatch(filt, msg) {
  const sources = filt.sources;
  if (sources && !sources.includes(msg.source)) return false;
  const pattern = filt.url_pattern;
  if (pattern) {
    const data = msg.data || {};
    const url = data.url || (data.request || {}).url || "";
    try {
      if (!new RegExp(pattern).test(url)) return false;
    } catch (e) { /* 坏正则不阻断投递 */ }
  }
  return true;
}

export class Bridge {
  constructor(workDir = WORK_DIR) {
    this.store = new EvidenceStore(workDir);
    this.extension = null;
    this.extension_info = {};
    this.pending = new Map(); // requestId -> resolve
    this.req_counter = 0;
    this.event_seq = 0;
    this.event_buffer = []; // ring buffer，上限 EVENT_BUFFER_SIZE
    // ws -> 订阅过滤器 {"sources": [...]|null, "url_pattern": str|null}
    this.subscribers = new Map();
    // 当前进行中的 task：{"id","title","rel_dir"} 或 null
    this.current_task = null;
    // 两条长生命周期日志都走 RollingJsonl（按天切分 + 大小上限 + 过期清理），
    // 流内部自己处理写错误：磁盘满/work 丢失不该崩进程，事件仍可经 events
    // 接口从内存 ring buffer 补拉。
    // events 默认关闭，理由见 EVENTS_LOG_ENABLED 处的注释。
    this.events_log = EVENTS_LOG_ENABLED
      ? new RollingJsonl(this.store, "events",
                         { maxBytes: LOG_MAX_FILE_BYTES, keepDays: LOG_KEEP_DAYS })
      : null;
    this.session_log = new RollingJsonl(this.store, "sessions",
                                        { maxBytes: LOG_MAX_FILE_BYTES,
                                          keepDays: LOG_KEEP_DAYS });
    // 启动扫一次过期分片：daemon 常常一跑就是几天，只靠跨天钩子清不掉
    // 「上次运行留下的陈年日志」。
    this.session_log.sweep();
    if (this.events_log) this.events_log.sweep();
  }

  // ---- 安全校验（Host + Origin 防 DNS rebinding / CSRF）----

  static handshakeRejectReason(req) {
    const host = (req.headers.host || "").toLowerCase();
    if (!ALLOWED_HOSTS.has(host)) return `bad Host: '${host}'`;
    const origin = req.headers.origin;
    if (origin && !origin.startsWith("chrome-extension://")) {
      return `bad Origin: '${origin}'`;
    }
    return null;
  }

  // ---- 连接入口 ----

  onConnection(ws, req) {
    ws.on("error", () => {}); // 兜底，防 EventEmitter 未捕获 error 崩进程
    const reason = Bridge.handshakeRejectReason(req);
    if (reason) {
      ws.close(4403, reason);
      return;
    }
    const url = new URL(req.url || "/", "http://x");
    const pathname = url.pathname;
    if (pathname === "/ws") {
      this.handleExtension(ws);
    } else if (pathname === "/ctl") {
      this.handleController(ws);
    } else {
      ws.close(4404, `unknown path: ${pathname}`);
    }
  }

  // ---- 扩展通道 ----

  handleExtension(ws) {
    let gotHello = false;
    let pinger = null;
    // 首帧必须是 hello（10s 超时）
    const helloTimer = setTimeout(() => {
      if (!gotHello) ws.close(4400, "expect hello");
    }, 10000);

    ws.on("message", (data) => {
      const raw = data.toString();
      if (gotHello) {
        // 中转模式下同一条 socket 可能被**重新配对**：中转在同 role 顶替时
        // 用 close() 关掉旧的对端，而服务端主动 close 不触发 webSocketClose，
        // 于是 daemon 这一侧的 socket 还活着，新扩展配对后会在这条连接上再发
        // 一次 hello。原来这条 hello 被丢进 _onExtensionMessage —— 那里只认
        // pong/event/tool_result，静默丢弃，hello_ack 永不返回。扩展侧
        // helloAcked 卡在 false（popup 永久显示未连接），而 socket 是 open 的
        // 所以 onclose 不触发、重连与 deadman 都不启动，**没有任何自动恢复
        // 路径**，只能人工点重连。这里认出重握手并如实重置状态。
        let maybe;
        try { maybe = JSON.parse(raw); } catch (e) { maybe = null; }
        if (maybe && maybe.type === "hello") {
          console.log("[owb-daemon] extension RE-HANDSHAKE on the same socket");
          this.extension = ws;
          this.extension_info = maybe.payload || {};
          this._failPending("extension re-paired");
          ws.send(JSON.stringify({ type: "hello_ack", payload: { ok: true } }));
          this._audit({ dir: "ext<-", type: "hello", payload: this.extension_info });
          return;
        }
        this._onExtensionMessage(raw);
        return;
      }
      let hello;
      try {
        hello = JSON.parse(raw);
      } catch (e) {
        ws.close(4400, "expect hello");
        return;
      }
      if (hello.type !== "hello") {
        ws.close(4400, "expect hello");
        return;
      }
      // 协议族识别（非鉴权）：同机碰巧同端口的其他桥扩展（如 kimi-webbridge）
      // 会误连并触发单扩展顶替；client 标识不符直接拒，防误连不防恶意。
      const client = (hello.payload || {}).client;
      if (client !== EXTENSION_CLIENT) {
        ws.close(4400, `unknown client: ${JSON.stringify(client)}`);
        return;
      }
      gotHello = true;
      clearTimeout(helloTimer);

      if (this.extension !== null) {
        // 单扩展 MVP：旧连接被顶替（SW 重启重连场景）
        console.log("[owb-daemon] extension REPLACED by new connection");
        try { this.extension.close(4000, "replaced"); } catch (e) {}
        this._failPending("extension replaced");
      }

      this.extension = ws;
      this.extension_info = hello.payload || {};
      ws.send(JSON.stringify({ type: "hello_ack", payload: { ok: true } }));
      this._audit({ dir: "ext<-", type: "hello", payload: this.extension_info });

      pinger = setInterval(() => {
        try {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "ping", payload: { ts: Date.now() / 1000 } }));
          }
        } catch (e) {}
      }, PING_INTERVAL_S * 1000);
    });

    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (pinger) clearInterval(pinger);
      if (gotHello && this.extension === ws) {
        this.extension = null;
        console.log("[owb-daemon] extension DISCONNECTED");
        this._failPending("extension disconnected");
      }
    });
  }

  _onExtensionMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return;
    }
    const mtype = msg.type;

    if (mtype === "pong") return;

    if (mtype === "event") {
      this.event_seq++;
      const payload = msg.payload || {};
      const record = {
        seq: this.event_seq,
        ts: Date.now() / 1000,
        source: payload.source ?? null,
        data: payload.data ?? null,
      };
      this.event_buffer.push(record);
      if (this.event_buffer.length > EVENT_BUFFER_SIZE) this.event_buffer.shift();
      if (this.events_log) this.events_log.write(JSON.stringify(record) + "\n");
      this._broadcast({ type: "event", ...record });
      return;
    }

    if (mtype === "tool_result") {
      const rid = msg.requestId ?? null;
      const fut = this.pending.get(rid);
      this.pending.delete(rid);
      this._audit({ dir: "ext<-", type: "tool_result", requestId: rid,
                    payload: msg.payload ?? null });
      if (fut) fut(msg.payload || {});
      return;
    }
  }

  // ---- 控制器通道 ----

  handleController(ws) {
    // UX-51: 原来是 Promise 链串行队列 —— 一条 wait_user（最长 280s）会把
    // 这个连接上后续【所有】工具调用堵到它超时为止：AI 在等用户操作期间既
    // 不能截图也不能读页，更别提操作另一个 tab。
    //
    // 现在并发处理。安全性来源：每条 call 自带 id，结果按 id 回；pending 是
    // Map<requestId>；扩展侧 SW 本来就并发处理消息。需要顺序的场景（如
    // task_begin 必须在录制前）由调用方自己 await，与串行队列时行为一致。
    ws.on("message", (data) => {
      Promise.resolve()
        .then(() => this._onControllerMessage(ws, data.toString()))
        .catch((e) => {
          // 单条消息处理出错保底不崩 daemon 进程
          console.error("[owb-daemon] ctl handler error:", e);
        });
    });
    ws.on("close", () => {
      this.subscribers.delete(ws);
    });
  }

  async _onControllerMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return;
    }
    const mtype = msg.type;
    if (mtype === "call") {
      const name = String(msg.name || "");
      // timeout 缺省 30s、上限 300s；坏输入回退 30。
      // 下界同样必要：timeout:0 / 负数会让 setTimeout(…,0) 立刻触发，每次调用
      // 必然返回 TIMEOUT，而错误文案还建议「提高超时重试」——把调用方送进死循环。
      const t = Number(msg.timeout ?? 30);
      const timeout = Number.isNaN(t) ? 30 : Math.max(1, Math.min(t, 300));
      let result;
      if (name.startsWith("daemon.")) {
        // 本地工具也要进审计日志（全部 tool_call 按序落盘）
        this._audit({ dir: "ctl->", type: "tool_call", id: msg.id ?? null,
                      payload: { name, args: msg.args || {} } });
        // daemon 侧工具原来完全不受调用方 timeout 约束：CLI 在 ~130s 判失败
        // 返回，daemon 却继续对用户的真实浏览器执行剩下的步骤（workflow_run
        // 每步 60s、步数无上限）。「命令已失败、副作用还在发生」是自动化工具
        // 里最难排查的一类问题。这里把预算作为硬闸门套上去。
        result = await this._withBudget(name, timeout,
                                        this.call_local(name.slice(7), msg.args || {}));
        this._audit({ dir: "ctl<-", type: "tool_result", id: msg.id ?? null,
                      payload: result });
      } else {
        result = await this.call_tool(name, msg.args || {}, timeout);
      }
      ws.send(JSON.stringify({ type: "result", id: msg.id ?? null, ...result }));
    } else if (mtype === "subscribe") {
      // 订阅过滤：crypto hook 高频源不全量推流
      let sources = msg.sources;
      if (typeof sources === "string") sources = [sources];
      const filt = {
        sources: Array.isArray(sources) && sources.length ? [...sources] : null,
        url_pattern: msg.url_pattern || null,
      };
      this.subscribers.set(ws, filt);
      ws.send(JSON.stringify({ type: "subscribed", filter: filt }));
    } else if (mtype === "events") {
      const since = Math.trunc(Number(msg.since_seq || 0)) || 0;
      for (const rec of this.event_buffer) {
        if (rec.seq > since) {
          ws.send(JSON.stringify({ type: "event", ...rec }));
        }
      }
    }
  }

  _broadcast(msg) {
    if (!this.subscribers.size) return;
    const targets = [];
    for (const [s, f] of this.subscribers) {
      if (subMatch(f, msg)) targets.push(s);
    }
    if (!targets.length) return;
    const raw = JSON.stringify(msg);
    for (const s of targets) {
      try {
        if (s.readyState === WebSocket.OPEN) s.send(raw);
      } catch (e) {}
    }
  }

  // ---- 工具路由 ----

  async call_tool(name, args, timeout = 30.0) {
    // UX-85: daemon 侧工具必须带 daemon. 前缀走 call_local；不带前缀会被转发到
    // 扩展并撞 UNKNOWN_TOOL，AI 无从知道该加前缀。这里在错误里直接给出正确名字。
    // 注意不能自动改路由：status / download 两侧同名，语义不同。
    if (DAEMON_LOCAL_TOOLS.has(name) && !EXT_ONLY_OVERLAP.has(name)) {
      return { ok: false, error: {
        code: "UNKNOWN_TOOL",
        message: `${name} is a daemon-side tool; call it as "daemon.${name}" ` +
                 `(MCP name: daemon_${name})`,
        retryable: false } };
    }
    if (this.extension === null) {
      return { ok: false,
               error: { code: "NO_EXTENSION",
                        message: "no extension connected", retryable: true } };
    }
    const rid = `r${++this.req_counter}`;
    let resolveP;
    const p = new Promise((res) => { resolveP = res; });
    this.pending.set(rid, resolveP);
    const call = { type: "tool_call", requestId: rid,
                   payload: { name, args } };
    this._audit({ dir: "ext->", type: "tool_call", requestId: rid,
                  payload: call.payload });
    try {
      if (this.extension.readyState !== WebSocket.OPEN) {
        throw new Error("extension socket not open");
      }
      this.extension.send(JSON.stringify(call));
    } catch (e) {
      this.pending.delete(rid);
      return { ok: false,
               error: { code: "SEND_FAILED",
                        message: String(e && e.message ? e.message : e),
                        retryable: true } };
    }
    const timer = setTimeout(() => {
      if (this.pending.delete(rid)) {
        resolveP({ ok: false,
                   error: { code: "TIMEOUT",
                            // BUG-91: 原文案只说「timed out」，不说等了多久、
                            // 也不说是哪一层的超时，AI 无法判断该加时间还是放弃。
                            // 实测和风天气给到 120 秒仍超时——需要这些信息才能
                            // 得出「这站就是打不开」而不是继续加码重试。
                            message:
                              `tool ${name} did not respond within ${timeout}s ` +
                              "(daemon-side wait). Either the page is genuinely " +
                              "that slow/unreachable, or the extension is stuck — " +
                              "raise the call timeout once; if it times out again " +
                              "at a higher value, the site is the problem, not the timeout",
                            retryable: true } });
      }
    }, timeout * 1000);
    const payload = await p;
    clearTimeout(timer);
    return payload;
  }

  _failPending(reason) {
    for (const [, fut] of this.pending) {
      fut({ ok: false,
            error: { code: "DISCONNECTED", message: reason, retryable: true } });
    }
    this.pending.clear();
  }

  // ---- relay 客户端（中转模式）----
  //
  // daemon 拨 wss://<OWB_RELAY_URL>/<token>?role=controller → 等 {type:"relay_paired"}
  // → 同 tick 原子交接给 handleExtension(ws)（防 relay_paired 与扩展 hello 之间丢帧）。
  // 之后 tool_call/tool_result/event/ping 全部经中转透明转发，内部路由逻辑零改动。
  // /ctl 本地服务不受影响（CLI 仍连本地）。本地模式（env 不设）完全不执行此路径。

  static buildRelayUrl() {
    if (!OWB_RELAY_URL || !OWB_RELAY_TOKEN) return null;
    const base = OWB_RELAY_URL.replace(/\/+$/, "");
    const tok = encodeURIComponent(OWB_RELAY_TOKEN);
    return `${base}/${tok}?role=controller`;
  }

  startRelayClient() {
    if (this._relayStopping) return;
    const url = Bridge.buildRelayUrl();
    if (!url) return;

    let reconnectTimer = null;
    let delayMs = 1000;
    // 60s 上限：对公网中转每次重连都是一次 DO 计费请求（免费额度每月 1M），
    // 长时间失联时 15s 上限会无谓烧额度。
    const RECONNECT_MAX_MS = 60000;
    const resetBackoff = () => { delayMs = 1000; };
    const scheduleReconnect = () => {
      if (this._relayStopping) return;
      if (reconnectTimer) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        dial();
      }, delayMs);
      delayMs = Math.min(delayMs * 2, RECONNECT_MAX_MS);
    };

    const dial = () => {
      if (this._relayStopping) return;
      console.log("[owb-daemon] relay connecting", OWB_RELAY_URL);
      let ws;
      try {
        ws = new WebSocket(url, { maxPayload: MAX_PAYLOAD });
      } catch (e) {
        scheduleReconnect();
        return;
      }
      ws.on("error", () => {}); // 兜底防未捕获 error；close 会触发重连

      let handedOff = false;
      // 配对前最多等 30s（中转两端谁先到都行，对端是扩展）
      const pairTimer = setTimeout(() => {
        if (!handedOff) {
          try { ws.close(4400, "relay pair timeout"); } catch (e) {}
        }
      }, 30000);

      // 临时收 relay_paired；收到即原子交接（同 tick：off 临时 handler → handleExtension 挂自己的）
      const tempMsg = (data) => {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch (e) { return; }
        if (!msg || msg.type !== "relay_paired") return;
        clearTimeout(pairTimer);
        ws.off("message", tempMsg);
        handedOff = true;
        resetBackoff();
        this._relayState = { paired: true, since: Date.now() / 1000, failures: 0 };
        console.log("[owb-daemon] relay paired, handing off to extension channel");
        // 复用扩展通道：之后扩展的 hello/hello_ack/tool_result/event 全部原样走
        this.handleExtension(ws);
      };
      ws.on("message", tempMsg);

      ws.on("close", () => {
        clearTimeout(pairTimer);
        // 已交接时 handleExtension 的 close 负责 this.extension/fail pending；
        // 这里只管重连调度。
        const st = this._relayState || { failures: 0 };
        this._relayState = {
          paired: false,
          since: Date.now() / 1000,
          // 连续配对失败计数：status 要能把「中转配好了」和「拨了半天没人应」
          // 分开，否则 token 打错 / 中转挂了，daemon 只会安静地无限重连，
          // 而 status 依旧一脸「relay 模式正常」。
          failures: handedOff ? 0 : (st.failures || 0) + 1,
        };
        if (!handedOff) console.log("[owb-daemon] relay closed before pair");
        scheduleReconnect();
      });
    };

    this._relayStop = () => { this._relayStopping = true; };
    dial();
  }

  // ---- daemon 本地工具（不经过浏览器）----

  async call_local(name, args) {
    if (name === "status") {
      const relayMode = !!(OWB_RELAY_URL && OWB_RELAY_TOKEN);
      // mode 原来只反映「环境变量配齐了没有」，与是否真的配对上无关：token
      // 打错、中转挂掉，status 照样报 mode:"relay" + relay_url，唯一的真信号
      // 是 extension_connected。把真实配对态一起报出来。
      const rs = this._relayState;
      const out = {
        mode: relayMode ? "relay" : "local",
        relay_url: relayMode ? OWB_RELAY_URL : null,
        extension_connected: this.extension !== null,
        extension_info: this.extension_info,
        event_seq: this.event_seq,
        pending: this.pending.size,
        subscribers: this.subscribers.size,
        current_task: this.current_task ? this.current_task.id : null,
      };
      if (relayMode) {
        out.relay_paired = !!(rs && rs.paired);
        if (rs && !rs.paired && rs.failures > 0) {
          out.relay_pair_failures = rs.failures;
          out._hint =
            `relay configured but not paired (${rs.failures} attempt(s) closed ` +
            "before pairing). The browser side has not joined this room — check " +
            "that the extension popup has the same relay URL and token, and that " +
            "the URL is wss://.";
        }
      }
      return { ok: true, data: out };
    }
    if (name === "shutdown") {
      // 升级路径的最后一步：老进程退出，下一条 owb 命令 autostart 时跑的就是
      // npm -g 更新后的新代码。延迟退出是为了让这条结果先送达 ctl 端。
      // process.exit 不等 pending 写入，退出瞬间的审计记录会丢——先收流。
      setTimeout(() => {
        try { this.session_log.end(); } catch (e) {}
        try { if (this.events_log) this.events_log.end(); } catch (e) {}
        process.exit(0);
      }, 200);
      return { ok: true, data: {
        note: "daemon exiting; it restarts on the next owb command",
      } };
    }
    if (name === "hook_logs") {
      // hook_logs 取证：从事件 ring buffer 查 hook 命中
      const source = args.source; // 源名，默认全部 hook:* 事件
      // UX-212: 参数名是 since_seq，AI 惯性写 since —— 原来静默忽略，
      // 返回全量历史，看着像"过滤没生效"。
      const since = Math.trunc(Number(args.since_seq ?? args.since ?? 0)) || 0;
      const limit = Math.min(Math.trunc(Number(args.limit || 100)) || 0, 500);
      // UX-211: ring buffer 是全局的，多 tab 同时挂 hook 时事件混在一起，
      // AI 拿到别的 tab 的事件当成本 tab 的。
      const tabId = args.tabId != null ? Number(args.tabId) : null;
      const out = [];
      let otherTabs = 0;
      for (const rec of this.event_buffer) {
        if (rec.seq <= since) continue;
        const src = rec.source || "";
        if (source) {
          // UX-114: source:"hook" 这种前缀写法原来一条都匹配不到（严格相等）
          if (src !== source && !src.startsWith(source + ":")) continue;
        } else if (!src.startsWith("hook:")) {
          continue;
        }
        if (tabId != null) {
          const evTab = rec.data && rec.data.tabId;
          if (evTab != null && Number(evTab) !== tabId) { otherTabs++; continue; }
        }
        out.push(rec);
        if (out.length >= limit) break;
      }
      return { ok: true, data: {
        events: out,          // 字段名是 events，不是 logs（UX-95）
        count: out.length,
        event_seq: this.event_seq,
        filtered_other_tabs: otherTabs || undefined,
      } };
    }
    // UX-186: 会话库只能存/读/列，删不掉 —— 过期登录态只能手工去 work/ 下删
    if (name === "state_delete") {
      if (!args.name) {
        return { ok: false, error: {
          code: "BAD_ARGS", message: "state_delete: name is required",
          retryable: false } };
      }
      const slug = _slug(args.name);
      const p = this.store._abs(`states/${slug}.json`);
      if (!fs.existsSync(p)) {
        return { ok: false, error: {
          code: "NOT_FOUND", message: `state not found: ${slug}`,
          retryable: false } };
      }
      fs.unlinkSync(p);
      return { ok: true, data: { name: slug, deleted: true } };
    }
    if (name === "verify_signer") {
      // BUG-28/BUG-45: MCP 描述写的是 source/calls，实现读的是 signer_code/samples。
      // 两套名字都收——AI 照文档传参不该必然失败。
      const code = args.signer_code || args.source || "";
      if (!code) {
        return { ok: false, error: {
          code: "BAD_ARGS",
          // UX-55: 裸 function 声明求值为 undefined，这一点必须写进错误里
          message: "verify_signer: source (or signer_code) is required — " +
                   "JS that evaluates to a function, e.g. \"(input) => ({sig: ...})\"; " +
                   "a bare function declaration evaluates to undefined, wrap it in parens",
          retryable: false } };
      }
      const samples = args.samples || [];
      // UX-109: 只给 calls（没有 expected）时走 dry-run，把算出来的值交回去；
      // 不伪造 expected 来凑 pass_rate（自己跟自己比必然通过 = 假成功）。
      if (!samples.length && Array.isArray(args.calls) && args.calls.length) {
        const out = dry_run_signer(code, args.calls);
        if ("error" in out) {
          return { ok: false, error: {
            code: "VERIFY_FAILED", message: out.error, retryable: false } };
        }
        return { ok: true, data: out };
      }
      const out = verify_signer(code, samples);
      if ("error" in out && !("results" in out)) {
        return { ok: false, error: {
          code: "VERIFY_FAILED", message: out.error, retryable: false } };
      }
      // UX-56: 全部样本对拍失败还 ok=true 是误导——AI 会当成验证通过。
      if (out.pass_rate === 0 && out.results && out.results.length > 0) {
        return { ok: false, error: {
          code: "VERIFY_FAILED",
          message: `all ${out.results.length} samples failed (pass_rate=0); ` +
                   "see data.results[].first_divergence for the byte offset",
          data: out,
          retryable: false } };
      }
      return { ok: true, data: out };
    }
    if (name === "replay") {
      const out = await replay(args);
      if (!out.ok) {
        return { ok: false, error: {
          code: "REPLAY_FAILED", message: out.error || "", retryable: true } };
      }
      return out;
    }
    if (name === "evidence_write") {
      if (args.path === undefined) {
        return { ok: false, error: {
          code: "BAD_ARGS", message: "evidence_write: path is required",
          retryable: false } };
      }
      // BUG-114: content 缺省时原来走 String(content || "") → 写出一个**空文件**
      // 还回 ok:true。取证归档最不该做的就是"成功地存了个空文件"——真出事时
      // 那份证据已经没了。缺 content 跟缺 path 一样属于用法错误，明说。
      if (args.content === undefined) {
        return { ok: false, error: {
          code: "BAD_ARGS",
          message: "evidence_write: content is required (pass \"\" to write " +
            "an intentionally empty file)",
          retryable: false } };
      }
      try {
        const content = args.content;
        let p;
        if (typeof content === "object" && content !== null) {
          p = this.store.write_json(args.path, content);
        } else {
          // BUG-114: 原来是 String(content || "")，于是 0 和 false 都被悄悄
          // 写成空文件。布尔按 Python 风格写 True/False，其余原样字符串化。
          const text =
            content === true ? "True"
            : content === false ? "False"
            : content === null ? ""
            : String(content);
          p = this.store.write_text(args.path, text);
        }
        // 返回字节数，调用方不用再自己去 stat 一遍确认真的落盘了
        let bytes;
        try { bytes = fs.statSync(p).size; } catch (e) {}
        return { ok: true, data: { path: p, bytes } };
      } catch (e) {
        return { ok: false, error: {
          code: "WRITE_FAILED",
          message: String(e && e.message ? e.message : e),
          retryable: false } };
      }
    }
    // ---- task 归档命名空间：work/tasks/<id>/ ----
    if (name === "task_begin") {
      // BUG-110: 也认 args.name —— CLI 曾把位置参数传成 name，直接调工具的
      // 调用方可能沿用了那个形状；两个都收，别再静默丢标题。
      const title = String(args.title || args.name || "").trim();
      let taskId = tsId();
      // BUG-119 判死的就是这条内联 ASCII 正则（原来是
      // `replace(/[^a-z0-9]+/g,"-")`），_slug 那边早就改成了 Unicode 安全版，
      // 这里却又复制了一份旧的：纯中文标题 → slug 塌成空串 → taskId 退化成
      // 纯时间戳，而 tsId 只到秒 —— 同一秒内两次 task_begin 会拿到相同 id，
      // 后一个 write_json 直接覆盖前一个任务的元数据。复用唯一真源。
      const slug = _slug(title);
      if (slug) taskId += `-${slug}`;
      // BUG-119 只修好了"中文标题 slug 塌成空串"这一半：同一秒内两次**同名**
      // task_begin 依然会算出完全相同的 id（tsId 只到秒 + 相同 slug）。而同名
      // task begin 复用分组是文档化行为，撞名撞秒并不罕见。后果不止是元数据
      // 互相覆盖：task_id 是 task_end 判断所有权的唯一凭证，id 一样就等于两个
      // 任务共用一个身份，谁也认不出谁。撞了就往后加序号，保证 id 真的唯一。
      if (fs.existsSync(this.store._abs(`tasks/${taskId}/task.json`))) {
        let n = 2;
        while (fs.existsSync(this.store._abs(`tasks/${taskId}-${n}/task.json`))) n++;
        taskId = `${taskId}-${n}`;
      }
      const meta = { id: taskId, title,
                     began_at: isoSeconds(),
                     began_ts: Date.now() / 1000,
                     begin_event_seq: this.event_seq };
      this.store.write_json(`tasks/${taskId}/task.json`, meta);
      this.current_task = { id: taskId, title,
                            rel_dir: `tasks/${taskId}` };
      // 扩展侧建 task:<title> 标签分组；扩展不在线或其他失败都容忍。
      // 必须把 task_id 一起传过去：task_end 的所有权校验按 id 比对，标题
      // 不唯一（同名复用分组是文档化行为），拿标题当身份会互相放行。
      const ext = await this.call_tool("task_context",
                                       { title: title || taskId,
                                         task_id: taskId }, 10);
      return { ok: true, data: { task_id: taskId,
                                 dir: `tasks/${taskId}`,
                                 ext_sync: Boolean(ext.ok) } };
    }
    if (name === "task_end") {
      // 并发修复：current_task 是这个 Bridge 单例上唯一一份全局指针，被多个
      // 并行调用方共享——不传 task_id 时谁的 task_begin 后调用，指针就归谁，
      // 之前所有调用方的裸 task_end 要么扑空（NO_TASK）要么打偏（成功但
      // 关掉了别人的任务，且没有任何报错信号）。呼应 workflow_save 早就有的
      // args.task_id 兜底：允许显式指定要结束哪个任务，不再必须依赖“当前”。
      const explicitId = args && args.task_id ? String(args.task_id) : null;
      const target = explicitId
        ? { id: explicitId, rel_dir: `tasks/${explicitId}` }
        : this.current_task;
      if (!target) {
        return { ok: false, error: {
          code: "NO_TASK",
          message: "no active task; call task_begin first",
          retryable: false } };
      }
      let meta;
      try {
        meta = JSON.parse(fs.readFileSync(
          this.store._abs(`${target.rel_dir}/task.json`), "utf8"));
      } catch (e) {
        // _abs 拒绝越权路径（task_id 里带 "../"）时抛的是"path escapes work
        // dir"，和"这个 id 压根没有对应任务"是两回事——前者是坏输入，
        // 后者才是真的 NOT_FOUND，别用同一个错误码把两种原因焐在一起。
        const msg = String((e && e.message) || e);
        if (/escapes work dir/.test(msg)) {
          return { ok: false, error: {
            code: "BAD_ARGS", message: `task_end: invalid task_id: ${msg}`,
            retryable: false } };
        }
        return { ok: false, error: {
          code: "NOT_FOUND", message: `task not found: ${target.id}`,
          retryable: false } };
      }
      // 只有 target 仍然是扩展侧真正持有的"当前任务"时，才去停录制/清分组——
      // 如果它已经被后来的 task_begin 顶替，扩展里的录制和标签分组早就归了
      // 别的任务，这时候动它们只会误伤别人；这种情况下只把自己的 task.json
      // 收尾归档，不碰扩展状态、也不清全局指针（不是自己的，没资格清）。
      const isCurrent = Boolean(this.current_task) &&
        this.current_task.id === target.id;
      const relDir = target.rel_dir;
      const harFiles = [];
      let group = null;
      // isCurrent 只是"打这通调用前一刻"的快照，接下来这次 await 期间完全
      // 可能被另一个并发 task_begin 顶替——不能拿它直接指挥停录制/清分组这
      // 两个有真实副作用的动作。先问扩展"你现在真的还认我是当前任务吗"
      // （带 expected_title 核对，见 task_context 实现），拿它当下的活答案。
      // ⚠️ 只有扩展**明确回答"现在的 current 不是你"**（reason:not_current）
      // 才认定自己已被顶替。扩展离线、SW 被回收、根本没有任务上下文这些情况
      // 都不构成"我不是 current"的证据——那时 daemon 侧的 current_task 就是
      // 唯一可信来源，维持原判。（第一版没分清这两者，扩展一掉线所有正常收尾
      // 都被误标成 ended_stale，冒烟测试当场抓到。）
      let actuallyCurrent = isCurrent;
      if (isCurrent) {
        const ext = await this.call_tool("task_context",
          { action: "clear", expected_task_id: target.id }, 10);
        group = ext.ok ? (ext.data ?? null) : null;
        if (group && group.cleared === false && group.reason === "not_current") {
          actuallyCurrent = false;
        }
        // 自动收尾：只停这个任务名下这几个 tab 的 recorder，HAR 落到 task
        // 目录（防忘关录制；task 成为完整会话容器，含 HAR + workflow）。
        // 显式传 tabIds（扩展刚回的、真正属于这个任务的标签页——它自己记的
        // 那份 ∪ 分组里现存的）而不是留空触发"停全部合并"，后者会连带停掉、
        // 吞并别的并发任务自己开的录制。
        const myTabIds = (group && group.tabIds) || [];
        if (actuallyCurrent && myTabIds.length) {
          try {
            const stopRes = await this.call_tool("record_stop",
              { title: meta.title || target.id, tabIds: myTabIds }, 30);
            if (stopRes.ok && stopRes.data && stopRes.data.har) {
              const harPath = `${relDir}/recording.har`;
              this.store.write_json(harPath, stopRes.data.har);
              harFiles.push({ path: harPath, entries: stopRes.data.entries || 0,
                              bodyBytes: stopRes.data.bodyBytes || 0 });
            }
          } catch (e) { /* 无录制或扩展离线，忽略 */ }
        }
        // 有录制跑在本任务范围之外的 tab 上：不越界替它收尾（那正是并发误伤
        // 的来源），但必须说出来。以前是静默跳过，调用方会以为"本来就没有
        // 录制"，实际是录制还在跑、数据一个字节都没落盘。
        if (group && (group.recordersOutsideTask || []).length) {
          meta.recorders_not_archived = group.recordersOutsideTask;
          meta.recorders_not_archived_note =
            "these tabs were still recording but are not part of this task, " +
            "so task_end left them alone — call har save on them yourself, " +
            "or the recording is never written to disk";
        }
      }
      Object.assign(meta, {
        ended_at: isoSeconds(),
        ended_ts: Date.now() / 1000,
        end_event_seq: this.event_seq,
        // event_seq 是整个 daemon 唯一一份全局计数器，不分任务。ended_stale
        // 场景下"从 begin_event_seq 到现在"这段窗口早就被别的任务的事件
        // 灌满了，report 出一个数字只会显得精确、实则没有意义——不如明确
        // 给 null，让调用方知道这不是"这个任务真实产生了多少事件"。
        event_count: actuallyCurrent ? this.event_seq - meta.begin_event_seq : null,
        group,
        har_files: harFiles.length ? harFiles : undefined,
      });
      if (!actuallyCurrent) meta.ended_stale = true;
      this.store.write_json(`${relDir}/task.json`, meta);
      // 收尾前再核对一遍活指针，而不是复用上面 await 之前拍下的快照——
      // record_stop/task_context 那两个 await 期间，另一个并行调用方完全
      // 可能已经 task_begin 了一个新任务，把 current_task 顶替成了 C。
      // 这时候如果还照抄旧的 isCurrent（当时是 true）去清 current_task，
      // 清掉的就是跟这次 task_end 毫无关系的 C，而不是自己。收尾前用当下
      // 的活指针重新判一次，只清真的还指向自己的那份。
      if (this.current_task && this.current_task.id === target.id) {
        this.current_task = null;
      }
      return { ok: true, data: meta };
    }
    if (name === "task_list") {
      const out = [];
      for (const p of this._glob("tasks", "*/task.json")) {
        let t;
        try {
          t = JSON.parse(fs.readFileSync(p, "utf8"));
        } catch (e) {
          continue; // 坏文件跳过
        }
        out.push({ id: t.id ?? null, title: t.title ?? null,
                   began_at: t.began_at ?? null, ended_at: t.ended_at ?? null });
      }
      return { ok: true, data: {
        tasks: out,
        current: this.current_task ? this.current_task.id : null } };
    }
    // ---- 宏回放：把 task 时间窗内审计过的浏览器操作固化为工作流 ----
    if (name === "workflow_save") {
      const slug = _slug(args.name);
      if (!slug) {
        return { ok: false, error: {
          code: "BAD_ARGS", message: "workflow_save: name is required",
          retryable: false } };
      }
      // 时间窗：task_id → task.json 的 began_ts/ended_ts（缺省=现在）；
      // 否则当前任务（began_ts→现在）；都没有则让 agent 先 task_begin
      const taskId = args.task_id ||
        (this.current_task ? this.current_task.id : null);
      if (!taskId) {
        return { ok: false, error: {
          code: "NEED_TASK",
          // UX-67/UX-208: 统一英文错误消息
          message: "workflow_save needs task_id or an active task " +
                   "(call task_begin first to wrap the flow you want to save)",
          retryable: false } };
      }
      const metaPath = this.store._abs(`tasks/${taskId}/task.json`);
      if (!fs.existsSync(metaPath)) {
        return { ok: false, error: {
          code: "NOT_FOUND", message: `task not found: ${taskId}`,
          retryable: false } };
      }
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      const beganTs = meta.began_ts ?? null;
      const endedTs = meta.ended_ts || Date.now() / 1000;
      // 从 session 审计日志提取时间窗内的 ext-> tool_call（task_context 是
      // task 分组联动的内部管道，不固化）；坏行跳过
      const steps = [];
      let skippedState = 0;
      // 只读时间窗覆盖到的那几天。审计文件名就是 YYYYMMDD（滚动分片是
      // YYYYMMDD.N.jsonl），所以按名字就能筛掉绝大多数文件。
      // 原来这里是「glob 全部 sessions → readFileSync 整读 → split("\n")」：
      // 实测单日文件已到 130 MB，一次 flow save 就把整个事件循环同步卡住数秒
      //（期间所有 ctl 调用、扩展 tool_result、事件广播全部停摆），而且随日志
      // 增长线性恶化，最终会撞上 Node 单字符串上限直接失败。
      const dayOf = (ts) => ymd(new Date(ts * 1000));
      const days = new Set([dayOf(beganTs), dayOf(endedTs)]);
      for (let t = beganTs; t < endedTs; t += 86400) days.add(dayOf(t));
      for (const sp of this._glob("sessions", "*.jsonl")) {
        const m = /^(\d{8})/.exec(path.basename(sp));
        if (m && !days.has(m[1])) continue; // 认得出日期且不在窗口内
        // 逐行流式读，不把整个文件读进内存
        const rl = readline.createInterface({
          input: fs.createReadStream(sp, "utf8"),
          crlfDelay: Infinity,
        });
        for await (const line of rl) {
          if (!line) continue;
          let rec;
          try {
            rec = JSON.parse(line);
          } catch (e) {
            continue;
          }
          if (rec.dir !== "ext->" || rec.type !== "tool_call") continue;
          const ts = rec.ts;
          if (typeof ts !== "number" || !(beganTs <= ts && ts <= endedTs)) {
            continue;
          }
          const payload = rec.payload || {};
          if (payload.name === "task_context") continue;
          // import_state 的 args 是整包 cookie/storage。审计侧已按凭据抹掉，
          // 固化进来只会得到一个 "[redacted …]" 的坏步骤；何况把明文登录态
          // 焊进 workflow 文件本身就是又复制一份凭据。回放前用
          // `owb state load <名字>` 恢复登录态才是支持的路径。
          if (payload.name === "import_state") { skippedState++; continue; }
          steps.push({ name: payload.name ?? null, args: payload.args || {} });
        }
      }
      const p = this.store.write_json(`workflows/${slug}.json`, {
        name: slug,
        saved_at: isoSeconds(),
        task_id: taskId,
        steps,
        step_count: steps.length,
      });
      return { ok: true, data: {
        name: slug, step_count: steps.length, path: p,
        _hint: skippedState
          ? `skipped ${skippedState} import_state step(s) — a saved login is ` +
            "not baked into the workflow. Run `owb state load <name>` before " +
            "`owb flow run` to restore the session first."
          : undefined,
      } };
    }
    if (name === "workflow_run") {
      const slug = _slug(args.name);
      if (!slug) {
        return { ok: false, error: {
          code: "BAD_ARGS", message: "workflow_run: name is required",
          retryable: false } };
      }
      const wfPath = this.store._abs(`workflows/${slug}.json`);
      if (!fs.existsSync(wfPath)) {
        return { ok: false, error: {
          code: "NOT_FOUND", message: `workflow not found: ${slug}`,
          retryable: false } };
      }
      const wf = JSON.parse(fs.readFileSync(wfPath, "utf8"));
      const keepTabIds = Boolean(args.keep_tab_ids);
      const continueOnError = Boolean(args.continue_on_error);
      const results = [];
      let passed = 0;
      let failed = 0;
      const steps = wf.steps || [];
      // 回放的每一步都在动用户的真实浏览器。原来每步硬编码 60s、步数无上限，
      // 于是总耗时没有天花板：CLI 早就判失败返回了，daemon 还在替用户点下去。
      // 给一个总预算（默认贴着 ctl 上限 300s，可用 timeout_s 调），到点就停，
      // 并在结果里说清停在第几步——宁可少做，也不要在调用方已经放弃之后
      // 继续产生副作用。
      const budgetS = Math.max(10, Math.min(Number(args.timeout_s) || 280, 600));
      const deadline = Date.now() + budgetS * 1000;
      let ranOutOfTime = false;
      for (let i = 0; i < steps.length; i++) {
        const remainMs = deadline - Date.now();
        if (remainMs <= 0) { ranOutOfTime = true; break; }
        const step = steps[i];
        const stepArgs = { ...(step.args || {}) };
        if (!keepTabIds) {
          // 录制的 tabId 跨会话无意义，默认剥掉重放解析到当前活动 tab
          delete stepArgs.tabId;
        }
        // 每步超时同时受总预算约束：剩 5s 就别再起一个 60s 的调用
        const stepTimeout = Math.max(1, Math.min(60, Math.ceil(remainMs / 1000)));
        const res = await this.call_tool(step.name, stepArgs, stepTimeout);
        const ok = Boolean(res.ok);
        const rec = { i, name: step.name ?? null, ok };
        if (ok) {
          passed++;
        } else {
          failed++;
          rec.code = res.error && res.error.code !== undefined
            ? res.error.code : null;
        }
        results.push(rec);
        if (!ok && !continueOnError) break; // 默认首败即停
      }
      // 整体 ok=true：步骤失败信息在 results/failed 里，不算调用级错误。
      // UX-156/157: 但 AI 只看外层 ok 就会以为重放成功了 —— 把判定放到
      // data.ok，并在没跑完时说清楚为什么停、下一步怎么办。
      const total = steps.length;
      return { ok: true, data: {
        ok: failed === 0,
        name: slug,
        ran: results.length,
        total,
        passed,
        failed,
        results,
        timed_out: ranOutOfTime || undefined,
        _hint: ranOutOfTime
          ? `ran out of the ${budgetS}s replay budget after step ` +
            `${results.length}/${total} — the remaining steps were NOT run ` +
            "(deliberately: they would keep driving the user's browser after " +
            "the caller had already given up). Re-run with a larger " +
            "timeout_s, or split the workflow."
          : failed
          ? (!continueOnError && results.length < total
              ? `stopped at step ${results.length}/${total} (first failure); ` +
                "pass continue_on_error:true to run the rest. "
              : "") +
            "REF_STALE failures mean the workflow recorded @eN refs that no " +
            "longer exist — re-record with selectors, or re-run read_page " +
            "before replay. " +
            // BUG-84: 回放默认剥掉录制时的 tabId，改由「当前活动 tab」解析，
            // 所以浏览器里同时有别的活动（用户在切标签、或另一个流程在跑）时
            // 就会 AMBIGUOUS_TAB。实地测试中并行跑扫描即复现。
            "AMBIGUOUS_TAB failures mean replay resolves each step to the " +
            "active tab (recorded tabIds are dropped as meaningless across " +
            "sessions) — replay needs a quiet browser, or pass keep_tab_ids:true " +
            "if the original tabs are still open"
          : undefined,
      } };
    }
    if (name === "workflow_list") {
      const out = [];
      for (const p of this._glob("workflows", "*.json")) {
        let wf;
        try {
          wf = JSON.parse(fs.readFileSync(p, "utf8"));
        } catch (e) {
          continue; // 坏文件跳过
        }
        out.push({ name: wf.name || path.basename(p, ".json"),
                   step_count: wf.step_count ?? null,
                   saved_at: wf.saved_at ?? null });
      }
      return { ok: true, data: { workflows: out } };
    }
    // ---- 站点会话库：登录态按名存取，daemon 编排不经 agent 上下文 ----
    // ⚠️ states/ 含登录态敏感数据（cookie/storage/IndexedDB）；work/ 已 gitignore，
    //    分享仓库或打包 work/ 前注意别外泄。
    if (name === "state_save") {
      const slug = _slug(args.name);
      if (!slug) {
        return { ok: false, error: {
          code: "BAD_ARGS", message: "state_save: name is required",
          retryable: false } };
      }
      const callArgs = {};
      if (args.tabId !== null && args.tabId !== undefined) {
        callArgs.tabId = args.tabId;
      }
      const st = await this.call_tool("export_state", callArgs, 30);
      if (!st.ok) return st;
      const data = st.data || {};
      const p = this.store.write_json(`states/${slug}.json`, data);
      return { ok: true, data: {
        name: slug,
        origin: data.origin ?? null,
        exportedAt: data.exportedAt ?? null,
        path: p,
        cookies: (data.cookies || []).length,
      } };
    }
    if (name === "state_load") {
      const slug = _slug(args.name);
      if (!slug) {
        return { ok: false, error: {
          code: "BAD_ARGS", message: "state_load: name is required",
          retryable: false } };
      }
      const stPath = this.store._abs(`states/${slug}.json`);
      if (!fs.existsSync(stPath)) {
        return { ok: false, error: {
          code: "NOT_FOUND", message: `state not found: ${slug}`,
          retryable: false } };
      }
      const state = JSON.parse(fs.readFileSync(stPath, "utf8"));
      const callArgs = { state };
      if (args.tabId !== null && args.tabId !== undefined) {
        callArgs.tabId = args.tabId;
      }
      const res = await this.call_tool("import_state", callArgs, 30);
      if (res.ok) {
        const data = { ...(res.data || {}), name: slug };
        return { ok: true, data };
      }
      return res;
    }
    if (name === "state_list") {
      const out = [];
      for (const p of this._glob("states", "*.json")) {
        let st;
        try {
          st = JSON.parse(fs.readFileSync(p, "utf8"));
        } catch (e) {
          continue; // 坏文件跳过
        }
        out.push({ name: path.basename(p, ".json"),
                   origin: st.origin ?? null,
                   exportedAt: st.exportedAt ?? null });
      }
      return { ok: true, data: { states: out } };
    }
    // ---- HAR 录制落盘（编排：扩展 record_stop → EvidenceStore 写盘）----
    if (name === "har_save") {
      const callArgs = {};
      if (args.tabId != null) callArgs.tabId = args.tabId;
      if (args.title) callArgs.title = args.title;
      const stopRes = await this.call_tool("record_stop", callArgs, 60);
      if (!stopRes.ok) return stopRes;
      const data = stopRes.data || {};
      const har = data.har;
      if (!har) {
        return { ok: false, error: {
          code: "NO_HAR", message: "record_stop returned no har data",
          retryable: false } };
      }
      // 落盘路径：有活动 task 则进 task 目录（与 workflow 同处）；否则 har/<名>.har
      let rel;
      if (this.current_task) {
        rel = `${this.current_task.rel_dir}/recording.har`;
      } else {
        const slug = _slug(args.filename || args.title || `rec-${tsId()}`);
        rel = `har/${slug}.har`;
      }
      const p = this.store.write_json(rel, har);
      return { ok: true, data: {
        path: p, entries: data.entries || 0,
        // BUG-117: 「录到过的请求数」与「HAR 里真正写下的条数」的差额，
        // 别在这一层丢掉——否则调用方只看到一个数，不知道有请求没被序列化。
        entriesDropped: data.entriesDropped,
        entriesDroppedNote: data.entriesDroppedNote,
        bodyBytes: data.bodyBytes || 0, tabIds: data.tabIds || null,
      } };
    }
    // ---- E1 下载编排：扩展 download → work/downloads/ ----
    if (name === "download") {
      const dlDirAbs = this.store._abs("downloads");
      // BUG-99: 这里传的 save_path 其实用不上——chrome.downloads.download()
      // 的 filename 参数只能是相对 Chrome 自己配置的下载目录的相对路径，
      // 扩展那边压根没读 save_path（也读不了，API 不支持存到任意绝对路径）。
      // 文件实际落在用户真实的系统下载目录，不是这里以为的 work/downloads/。
      // 保留这个字段传给扩展没有坏处（万一以后扩展真支持了），但落盘位置
      // 不能再假装是 dlDirAbs——下面用 copy 把文件搬进 work/downloads/，
      // 不动用户真实下载目录里的原文件（不做静默删除）。
      const callArgs = { save_path: dlDirAbs };
      if (args.tabId != null) callArgs.tabId = args.tabId;
      if (args.url) callArgs.url = args.url;
      if (args.selector) callArgs.selector = args.selector;
      if (args.timeout_ms != null) callArgs.timeout_ms = args.timeout_ms;
      const res = await this.call_tool("download", callArgs, 180);
      if (!res.ok) return res;
      const data = res.data || {};
      let sandboxedPath = null;
      let copyErr = null;
      if (data.path && fs.existsSync(data.path)) {
        const dest = path.join(dlDirAbs, path.basename(data.path));
        // Windows 上文件刚写完时常被杀软/索引服务短暂锁一下，立刻 copy 偶发
        // EBUSY/EPERM；退避重试几次，比一次失败就放弃更可靠。
        for (const delayMs of [0, 200, 500]) {
          if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
          try {
            fs.copyFileSync(data.path, dest);
            sandboxedPath = dest;
            copyErr = null;
            break;
          } catch (e) {
            copyErr = e.message;
          }
        }
      }
      return { ok: true, data: {
        filename: data.filename || null,
        path: sandboxedPath || data.path || null,
        originalPath: data.path || null,
        receivedBytes: data.receivedBytes != null ? data.receivedBytes : null,
        dir: sandboxedPath
          ? `downloads/${path.basename(sandboxedPath)}`
          : null,
        note: sandboxedPath
          ? undefined
          : "could not copy into work/downloads/ (" + (copyErr || "file missing") +
            "); file is only at originalPath (your system Downloads folder)",
      } };
    }
    // ---- C7: HAR → 重放脚本（python/curl/node）----
    if (name === "har_to_replay") {
      let har;
      try { har = coerceHar(args.har); }
      catch (e) { return { ok: false, error: {
        code: e.owbCode || "BAD_HAR", message: e.message, retryable: false } }; }
      if (!har && args.path) {
        const abs = this.store._abs(args.path);
        if (!fs.existsSync(abs)) {
          return { ok: false, error: {
            code: "NOT_FOUND", message: `har not found: ${args.path}`,
            retryable: false } };
        }
        try { har = JSON.parse(fs.readFileSync(abs, "utf8")); }
        catch (e) {
          return { ok: false, error: {
            code: "BAD_HAR", message: `parse failed: ${e.message}`,
            retryable: false } };
        }
      }
      if (!har) {
        return { ok: false, error: {
          code: "BAD_ARGS", message: "har_to_replay: har or path is required",
          retryable: false } };
      }
      // UX-172: 非法 format 静默回退 python，AI 以为拿到的是 curl/node 脚本
      if (args.format !== undefined &&
          !["python", "curl", "node"].includes(args.format)) {
        return { ok: false, error: {
          code: "BAD_ARGS",
          message: `har_to_replay: bad format: ${args.format} ` +
                   "(valid: python|curl|node)",
          retryable: false } };
      }
      const format = args.format || "python";
      let out;
      try {
        // BUG-118: url_pattern 以前被静默忽略——整页几十条全量生成，
        // 调用方还以为过滤生效了
        out = harToReplay(har, format, { url_pattern: args.url_pattern });
      } catch (e) {
        return { ok: false, error: {
          code: "BAD_ARGS", message: e.message, retryable: false } };
      }
      // 落盘（可选）：replay/<名>.<ext>
      if (args.save) {
        const ext = format === "python" ? "py" : format === "node" ? "mjs" : "sh";
        const slug = _slug(args.save === true ? `replay-${tsId()}` : args.save);
        const rel = `replay/${slug}.${ext}`;
        const p = this.store.write_text(rel, out.code);
        out.path = p;
      }
      return { ok: true, data: out };
    }
    // ---- C8: 录制对比（两份 HAR）----
    if (name === "har_diff") {
      const loadHar = (src, label) => {
        if (src && typeof src === "object") return src;
        // UX-204: JSON 字符串直接解析，不要当成路径去找文件
        const inline = coerceHar(src, label);
        if (inline) return inline;
        if (typeof src === "string") {
          const abs = this.store._abs(src);
          if (!fs.existsSync(abs)) {
            throw new Error(`${label} not found: ${src}`);
          }
          return JSON.parse(fs.readFileSync(abs, "utf8"));
        }
        throw new Error(`${label}: provide har object or path`);
      };
      try {
        const baseline = loadHar(args.baseline, "baseline");
        const current = loadHar(args.current, "current");
        const result = harDiff(baseline, current);
        if (args.save) {
          const slug = _slug(args.save === true ? `diff-${tsId()}` : args.save);
          const p = this.store.write_json(`diff/${slug}.json`, result);
          result.path = p;
        }
        return { ok: true, data: result };
      } catch (e) {
        return { ok: false, error: {
          code: "DIFF_FAILED", message: e.message, retryable: false } };
      }
    }
    // ---- C9: 断言校验（一份 HAR vs 断言集）----
    if (name === "har_assert") {
      let har;
      try { har = coerceHar(args.har); }
      catch (e) { return { ok: false, error: {
        code: e.owbCode || "BAD_HAR", message: e.message, retryable: false } }; }
      if (!har && args.path) {
        const abs = this.store._abs(args.path);
        if (!fs.existsSync(abs)) {
          return { ok: false, error: {
            code: "NOT_FOUND", message: `har not found: ${args.path}`,
            retryable: false } };
        }
        try { har = JSON.parse(fs.readFileSync(abs, "utf8")); }
        catch (e) {
          return { ok: false, error: {
            code: "BAD_HAR", message: `parse failed: ${e.message}`,
            retryable: false } };
        }
      }
      if (!har) {
        return { ok: false, error: {
          code: "BAD_ARGS", message: "har_assert: har or path is required",
          retryable: false } };
      }
      // UX-173: 空断言集返回 pass_rate=1，AI 会当成"全部校验通过"
      if (!Array.isArray(args.assertions) || !args.assertions.length) {
        return { ok: false, error: {
          code: "BAD_ARGS",
          message: "har_assert: assertions[] is required and must be non-empty " +
                   "(an empty set would trivially 'pass'). Types: request_exists, " +
                   "request_absent, response_status, response_contains, min_requests",
          retryable: false } };
      }
      // 工具级 ok 表示"校验跑完了"，判定在 data.ok / data.failed 上（见 harAssert）
      return { ok: true, data: harAssert(har, args.assertions) };
    }
    return { ok: false, error: {
      code: "UNKNOWN_TOOL", message: `unknown daemon tool: ${name}`,
      retryable: false } };
  }

  /** work/<dir>/<pattern> 下匹配文件列表，仅支持 "*" / "*.ext" / "*\/file"。 */
  _glob(dir, pattern) {
    const base = this.store.root;
    const out = [];
    const dirAbs = path.join(base, dir);
    if (!fs.existsSync(dirAbs)) return out;
    if (pattern.includes("/")) {
      // tasks/*/task.json：一层子目录 + 固定文件名
      const [sub, file] = pattern.split("/");
      for (const entry of fs.readdirSync(dirAbs).sort()) {
        const p = path.join(dirAbs, entry, file);
        if (fs.existsSync(p)) out.push(p);
      }
    } else {
      const suffix = pattern.startsWith("*") ? pattern.slice(1) : null;
      for (const entry of fs.readdirSync(dirAbs).sort()) {
        if (suffix === null || entry.endsWith(suffix)) {
          out.push(path.join(dirAbs, entry));
        }
      }
    }
    return out;
  }

  /**
   * 给 daemon 侧工具套上调用方的时间预算。
   *
   * ⚠️ 这是「按时回话」，不是「取消执行」——JS 没法中断一个已经在跑的
   * async 函数，编排型工具（workflow_run / download）内部的 call_tool 各自
   * 有超时，会自己收尾。要点在于**调用方不再无限等**，且拿到的是一个说清了
   * 状况的错误，而不是 CLI 侧那个信息量为零的 `ctl call timeout`。
   */
  async _withBudget(name, timeoutS, promise) {
    let timer = null;
    const budget = new Promise((resolve) => {
      timer = setTimeout(() => resolve({
        ok: false,
        error: {
          code: "TIMEOUT",
          message: `${name} exceeded the ${timeoutS}s budget for this call. ` +
            "It may still be finishing daemon-side — check daemon.task_list / " +
            "flow list before retrying, and pass a larger timeout if the work " +
            "legitimately takes longer.",
          retryable: true,
        },
      }), timeoutS * 1000);
    });
    try {
      return await Promise.race([promise, budget]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  _audit(entry) {
    entry.ts = Date.now() / 1000;
    this.session_log.write(JSON.stringify(auditSafe(entry)) + "\n");
  }
}

export async function serve(workDir = WORK_DIR) {
  const bridge = new Bridge(workDir);
  const relayMode = !!(OWB_RELAY_URL && OWB_RELAY_TOKEN);
  console.log(`[owb-daemon] ws://${HOST}:${PORT}` +
              (relayMode
                ? `（中转模式：${OWB_RELAY_URL}）`
                : `（本地信任模型，无 token 认证）`));
  const wss = new WebSocketServer({ host: HOST, port: PORT, maxPayload: MAX_PAYLOAD });
  wss.on("connection", (ws, req) => bridge.onConnection(ws, req));
  await new Promise((resolve, reject) => {
    wss.once("listening", resolve);
    wss.once("error", reject);
  });
  wss.on("error", () => {});
  bridge.wss = wss;
  if (relayMode) bridge.startRelayClient();
  return bridge;
}

// 仅作为主模块直接运行时才启动（供测试 import 时不监听）
if (isMainModule(import.meta.url)) {
  serve().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

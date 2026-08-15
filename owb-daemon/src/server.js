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
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";

import { isMainModule } from "./ismain.js";

import { EvidenceStore } from "./evidence.js";
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
  "status", "hook_logs", "verify_signer", "replay", "evidence_write",
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
function _slug(name) {
  const raw = String(name || "").toLowerCase();
  // BUG-5: preserve trailing extension (e.g. .har) so "my_analysis.har"
  // doesn't become "my-analysis-har.har" with double extension.
  const extMatch = raw.match(/\.([a-z0-9]+)$/);
  const ext = extMatch ? extMatch[0] : "";
  const base = (ext ? raw.slice(0, -ext.length) : raw)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base + (base && ext ? ext : "");
}

const pad2 = (n) => String(n).padStart(2, "0");

/** 返回 YYYYMMDD（本地时区）。 */
function ymd(d = new Date()) {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
}

/** 返回 YYYYMMDD-HHMMSS（本地时区）。 */
function tsId(d = new Date()) {
  return `${ymd(d)}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

/** 返回 YYYY-MM-DDTHH:MM:SS（本地时区，无 tz 后缀）。 */
function isoSeconds(d = new Date()) {
  return `${ymd(d).replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3")}` +
    `T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
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
    this.events_log = this.store.open_jsonl("events/events.jsonl");
    this.session_log = this.store.open_jsonl(`sessions/${ymd()}.jsonl`);
    // 落盘流出错（磁盘满/work 目录丢失）不应崩进程：记日志即可，
    // 事件仍在内存 ring buffer 里，调用方可经 events 接口补拉
    this.events_log.on("error", (e) => console.error("[owb-daemon] events_log error:", e));
    this.session_log.on("error", (e) => console.error("[owb-daemon] session_log error:", e));
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
      this.events_log.write(JSON.stringify(record) + "\n");
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
      // timeout 缺省 30s、上限 300s；坏输入回退 30
      const t = Number(msg.timeout ?? 30);
      const timeout = Number.isNaN(t) ? 30 : Math.min(t, 300);
      let result;
      if (name.startsWith("daemon.")) {
        // 本地工具也要进审计日志（全部 tool_call 按序落盘）
        this._audit({ dir: "ctl->", type: "tool_call", id: msg.id ?? null,
                      payload: { name, args: msg.args || {} } });
        result = await this.call_local(name.slice(7), msg.args || {});
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
        console.log("[owb-daemon] relay paired, handing off to extension channel");
        // 复用扩展通道：之后扩展的 hello/hello_ack/tool_result/event 全部原样走
        this.handleExtension(ws);
      };
      ws.on("message", tempMsg);

      ws.on("close", () => {
        clearTimeout(pairTimer);
        // 已交接时 handleExtension 的 close 负责 this.extension/fail pending；
        // 这里只管重连调度。
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
      return { ok: true, data: {
        mode: relayMode ? "relay" : "local",
        relay_url: relayMode ? OWB_RELAY_URL : null,
        extension_connected: this.extension !== null,
        extension_info: this.extension_info,
        event_seq: this.event_seq,
        pending: this.pending.size,
        subscribers: this.subscribers.size,
        current_task: this.current_task ? this.current_task.id : null,
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
      if (title) {
        const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "").slice(0, 30);
        if (slug) taskId += `-${slug}`;
      }
      const meta = { id: taskId, title,
                     began_at: isoSeconds(),
                     began_ts: Date.now() / 1000,
                     begin_event_seq: this.event_seq };
      this.store.write_json(`tasks/${taskId}/task.json`, meta);
      this.current_task = { id: taskId, title,
                            rel_dir: `tasks/${taskId}` };
      // 扩展侧建 task:<title> 标签分组；扩展不在线或其他失败都容忍
      const ext = await this.call_tool("task_context",
                                       { title: title || taskId }, 10);
      return { ok: true, data: { task_id: taskId,
                                 dir: `tasks/${taskId}`,
                                 ext_sync: Boolean(ext.ok) } };
    }
    if (name === "task_end") {
      if (!this.current_task) {
        return { ok: false, error: {
          code: "NO_TASK",
          message: "no active task; call task_begin first",
          retryable: false } };
      }
      const relDir = this.current_task.rel_dir;
      const meta = JSON.parse(fs.readFileSync(
        this.store._abs(`${relDir}/task.json`), "utf8"));
      // 自动收尾：停所有活动 recorder，HAR 落到 task 目录
      // （防忘关录制；task 成为完整会话容器，含 HAR + workflow）
      const harFiles = [];
      try {
        const stopRes = await this.call_tool("record_stop",
          { title: this.current_task.title || this.current_task.id }, 30);
        if (stopRes.ok && stopRes.data && stopRes.data.har) {
          const harPath = `${relDir}/recording.har`;
          this.store.write_json(harPath, stopRes.data.har);
          harFiles.push({ path: harPath, entries: stopRes.data.entries || 0,
                          bodyBytes: stopRes.data.bodyBytes || 0 });
        }
      } catch (e) { /* 无录制或扩展离线，忽略 */ }
      // 拿扩展侧分组统计（action:clear 顺带清分组）；失败容忍，group=null
      const ext = await this.call_tool("task_context", { action: "clear" }, 10);
      const group = ext.ok ? (ext.data ?? null) : null;
      Object.assign(meta, {
        ended_at: isoSeconds(),
        ended_ts: Date.now() / 1000,
        end_event_seq: this.event_seq,
        event_count: this.event_seq - meta.begin_event_seq,
        group,
        har_files: harFiles.length ? harFiles : undefined,
      });
      this.store.write_json(`${relDir}/task.json`, meta);
      this.current_task = null;
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
      for (const sp of this._glob("sessions", "*.jsonl")) {
        for (const line of fs.readFileSync(sp, "utf8").split("\n")) {
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
      return { ok: true, data: { name: slug, step_count: steps.length,
                                 path: p } };
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
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const stepArgs = { ...(step.args || {}) };
        if (!keepTabIds) {
          // 录制的 tabId 跨会话无意义，默认剥掉重放解析到当前活动 tab
          delete stepArgs.tabId;
        }
        const res = await this.call_tool(step.name, stepArgs, 60);
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
        _hint: failed
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
      const out = harToReplay(har, format);
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

  _audit(entry) {
    entry.ts = Date.now() / 1000;
    this.session_log.write(JSON.stringify(entry) + "\n");
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

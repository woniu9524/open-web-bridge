#!/usr/bin/env node
/**
 * Open Web Bridge daemon — WS server。
 *
 * 拓扑（默认端口 18086；10086 与 kimi-webbridge 默认端口冲突，故更换）：
 *   扩展  → ws://127.0.0.1:18086/ws   （hello 握手，Host/Origin 校验防 DNS rebinding）
 *   控制器 → ws://127.0.0.1:18086/ctl  （call / subscribe / events 补拉）
 *
 * 仅绑定 127.0.0.1。本地信任模型：无 token 认证（同机任意进程可连），
 * Host/Origin 校验防网页 DNS rebinding。
 *
 * 端口可用环境变量 OWB_PORT 覆盖（e2e 与日常浏览器隔离用；
 * 单扩展模型下两个浏览器实例会在同一端口上互相顶替）。
 *
 * MCP(stdio) 接入面由 mcp_server.js 提供（薄转发到 ctl），
 * client.js CLI 保留作调试。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import WebSocket, { WebSocketServer } from "ws";

import { EvidenceStore } from "./evidence.js";
import { verify_signer } from "./verify.js";
import { replay } from "./replay.js";

export const HOST = "127.0.0.1";
export const PORT = parseInt(process.env.OWB_PORT || "18086", 10);
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

// ---- 安全（Host + Origin 校验防 DNS rebinding / CSRF）----
// 本地信任模型：仅绑定 127.0.0.1，不做 token 认证（同机任意进程可连）。
// Host/Origin 是两层防线中的第二层：防网页经 DNS rebinding 打本机 daemon。

// --- 小工具 -----------------------------------------------------------------

/** 工作流/会话库文件名 slug：小写、非字母数字转 -、截 40。 */
function _slug(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 40);
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
    // 每连接串行处理：上一个 call 处理完才读下一条
    let queue = Promise.resolve();
    ws.on("message", (data) => {
      queue = queue
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
                            message: `tool ${name} timed out`, retryable: true } });
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
  // /ctl 本地服务不受影响（mcp_server 仍连本地）。本地模式（env 不设）完全不执行此路径。

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
    const RECONNECT_MAX_MS = 15000;
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
      const source = args.source; // 精确源名，默认全部 hook:* 事件
      const since = Math.trunc(Number(args.since_seq || 0)) || 0;
      const limit = Math.min(Math.trunc(Number(args.limit || 100)) || 0, 500);
      const out = [];
      for (const rec of this.event_buffer) {
        if (rec.seq <= since) continue;
        const src = rec.source || "";
        if (source) {
          if (src !== source) continue;
        } else if (!src.startsWith("hook:")) {
          continue;
        }
        out.push(rec);
        if (out.length >= limit) break;
      }
      return { ok: true, data: { events: out, count: out.length,
                                 event_seq: this.event_seq } };
    }
    if (name === "verify_signer") {
      const out = verify_signer(args.signer_code || "", args.samples || []);
      if ("error" in out && !("results" in out)) {
        return { ok: false, error: {
          code: "VERIFY_FAILED", message: out.error, retryable: false } };
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
      try {
        const content = args.content;
        let p;
        if (typeof content === "object" && content !== null) {
          p = this.store.write_json(args.path, content);
        } else {
          // 布尔 true 写 "True"，其余 falsy 写 ""
          const text = content === true ? "True" : String(content || "");
          p = this.store.write_text(args.path, text);
        }
        return { ok: true, data: { path: p } };
      } catch (e) {
        return { ok: false, error: {
          code: "WRITE_FAILED",
          message: String(e && e.message ? e.message : e),
          retryable: false } };
      }
    }
    // ---- task 归档命名空间：work/tasks/<id>/ ----
    if (name === "task_begin") {
      const title = String(args.title || "").trim();
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
      // 拿扩展侧分组统计（action:clear 顺带清分组）；失败容忍，group=null
      const ext = await this.call_tool("task_context", { action: "clear" }, 10);
      const group = ext.ok ? (ext.data ?? null) : null;
      Object.assign(meta, {
        ended_at: isoSeconds(),
        ended_ts: Date.now() / 1000,
        end_event_seq: this.event_seq,
        event_count: this.event_seq - meta.begin_event_seq,
        group,
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
          message: "workflow_save 需要 task_id 或活动任务" +
                   "（先 task_begin 包住要固化的流程）",
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
      // 整体 ok=true：步骤失败信息在 results/failed 里，不算调用级错误
      return { ok: true, data: { name: slug, ran: results.length,
                                 passed, failed, results } };
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
const isMain = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  serve().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

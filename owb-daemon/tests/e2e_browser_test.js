/**
 * 真机端到端测试：headless Chrome + 真扩展 + 真 daemon + 本地靶站。
 *
 * 全链路验证（这些是 mock 测不到、只在真机才能暴露的行为）：
 *   CDP attach、navigate/evaluate、Network 抓包 + initiator 栈、
 *   hook_preset(xhr) 注入时序（addScriptToEvaluateOnNewDocument + reload）、
 *   hook_function trace、oracle_call 确定性样本、capture_request 宏工具、
 *   break_xhr 暂停 + frame_read frozen-snapshot、export/import_state、env_compare。
 *
 * 靶站：本地 http 服务器，页面带确定性计算函数 owbSign + fireRequest() 发 XHR。
 *
 * 自我端口隔离：挑空闲端口 spawn `node src/server.js`（OWB_PORT +
 * OWB_WORK_DIR=临时目录），扩展副本改写默认 wsUrl 指向同一端口，跑完杀子进程。
 *
 * 运行：cd owb-daemon && node tests/e2e_browser_test.js
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { isMainModule } from "../src/ismain.js";
import { HOST, makeChecker, freePort, waitPort, killProc, onceOpen, tk } from "./kit.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const REPO = path.resolve(__dirname, "..", "..");
const DAEMON_DIR = path.join(REPO, "owb-daemon");
const EXT_DIR = path.join(REPO, "owb-extension");

// e2e 用独立端口 + 扩展副本（改写副本默认 wsUrl 指向独立端口）：
// 单扩展模型下，日常浏览器里已连接的扩展会与 headless 测试浏览器互相顶替
// （REPLACED ping-pong 把进行中的 tool_call 打成 DISCONNECTED），必须隔离。

const { check, summarize } = makeChecker();

const jstr = (o) => JSON.stringify(o);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function owbSign(input) {
  // 与靶站页面 owbSign 完全一致的 Node 复刻（样本期望值）
  const s = input + "|1700000000000";
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return "sig_" + h.toString(16);
}

const EXPECTED_SIG = owbSign("payload1");

const PAGE_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>owb-target</title></head><body>
<button id="btn1" onclick="var d=document.createElement('div');d.id='clicked-mark';d.innerText='已点击';document.body.appendChild(d);">搜索</button>
<button id="btn2">真人检验</button>
<input id="ipt1" placeholder="关键词">
<article><h1>靶站文章</h1><p>第一段正文内容。</p><p>第二段正文内容，包含分析细节。</p></article>
<script>
setTimeout(function() {
  var d = document.createElement('div');
  d.id = 'late'; d.innerText = '迟到元素';
  document.body.appendChild(d);
}, 2000);
function owbSign(input) {
  const t = 1700000000000;
  let h = 0; const s = input + "|" + t;
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) >>> 0; }
  return "sig_" + h.toString(16);
}
window.owbSign = owbSign;
async function fireRequest() {
  const sig = owbSign("payload1");
  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/data?sig=" + sig);
  xhr.setRequestHeader("X-Sign", sig);
  xhr.send(JSON.stringify({q: 1}));
  return sig;
}
window.fireRequest = fireRequest;
// 真人检验：isTrusted 只有真实输入管线（CDP Input.dispatchMouseEvent / 人手）才为 true
document.getElementById('btn2').addEventListener('click', function(ev) {
  var prev = window.__owbTrust || { count: 0 };
  window.__owbTrust = { trusted: ev.isTrusted, count: prev.count + 1 };
});
</script>
</body></html>`;

function chromeCandidates() {
  /** 候选浏览器。⚠️ Google Chrome 品牌版拒绝 --load-extension（日志：
   *  '--load-extension is not allowed in Google Chrome, ignoring'），
   *  必须用 Playwright 下载的完整版 Chromium（非 headless_shell，它不支持扩展）。
   *  按版本号从新到旧取第一个存在的。 */
  const cands = [];
  const roots = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "ms-playwright") : "",
    "C:\\Users\\Administrator\\AppData\\Local\\ms-playwright",
  ];
  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue;
    const builds = [];
    for (const d of fs.readdirSync(root, { withFileTypes: true })) {
      if (d.isDirectory() && d.name.startsWith("chromium-")
          && /^\d+$/.test(d.name.split("-")[1] || "")) {
        builds.push([parseInt(d.name.split("-")[1], 10), d.name]);
      }
    }
    builds.sort((a, b) => b[0] - a[0]);
    for (const [, name] of builds) {
      for (const sub of ["chrome-win64", "chrome-win"]) {
        const exe = path.join(root, name, sub, "chrome.exe");
        if (fs.existsSync(exe)) cands.push(exe);
      }
    }
  }
  // 兜底：品牌版 Chrome/Edge（已知会静默忽略 --load-extension，仅留作人工排查用）
  cands.push(
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  );
  return cands;
}

function startTargetServer() {
  /** 本地靶站：/page.html 出页面，其余 GET 出回声 JSON，POST 回显 X-Sign 头与 body。
   *  ⚠️ POST 回显手工拼 JSON，保持 ": " 空格风格——
   *  e2e 的 network_detail 断言按字节匹配 '"ok": true'。 */
  const server = http.createServer((req, res) => {
    if (req.method === "GET") {
      let body, ctype;
      if (req.url.startsWith("/page.html")) {
        body = PAGE_HTML;
        ctype = "text/html";
      } else {
        body = `{"ok": true, "path": ${jstr(req.url)}}`;
        ctype = "application/json";
      }
      res.writeHead(200, { "Content-Type": ctype, "Content-Length": Buffer.byteLength(body) });
      res.end(body);
    } else if (req.method === "POST") {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        const body = `{"ok": true, "sig": ${jstr(req.headers["x-sign"] ?? null)}, "body": ${jstr(raw)}}`;
        res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
        res.end(body);
      });
    }
  });
  return new Promise((resolve) => {
    server.listen(0, HOST, () => resolve({ server, port: server.address().port }));
  });
}

function withTimeout(promise, ms, label = "timeout") {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); }),
  ]);
}

class Ctl {
  /** 控制器连接：直连 ctl + call + 可选订阅收集事件。 */
  constructor(port, token = null) {
    this.port = port;
    this.token = token;
    this.ws = null;
    this.counter = 0;
    this.events = [];
    this.pending = new Map();   // id -> {resolve, reject, timer}
    this._ackWaiters = [];      // subscribed 回执等待队列
  }

  async connect(subscribe = false) {
    this.ws = new WebSocket(tk(`ws://${HOST}:${this.port}/ctl`, this.token));
    this.ws.on("error", () => {});  // 长连接常驻兜底，防 EventEmitter 无监听抛异常
    this.ws.on("message", (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === "event") { this.events.push(msg); return; }
      if (msg.type === "subscribed") {
        const w = this._ackWaiters.shift();
        if (w) w(msg);
        return;
      }
      if (msg.type === "result") {
        const p = this.pending.get(String(msg.id));
        if (p) { this.pending.delete(String(msg.id)); p.resolve(msg); }
      }
    });
    this.ws.on("close", () => {
      for (const p of this.pending.values()) p.reject(new Error("ctl disconnected"));
      this.pending.clear();
    });
    await onceOpen(this.ws);
    if (subscribe) {
      const ack = new Promise((r) => this._ackWaiters.push(r));
      this.ws.send(jstr({ type: "subscribe" }));
      await withTimeout(ack, 10000, "subscribe ack timeout");
    }
  }

  call(name, args = {}, timeout = 30) {
    this.counter += 1;
    const cid = `e2e-${this.counter}`;
    return new Promise((resolve, reject) => {
      // 宽限 2s 让 daemon 自己的 TIMEOUT 先回来，避免边界竞态
      const timer = setTimeout(() => {
        this.pending.delete(cid);
        reject(new Error(`call ${name} timeout`));
      }, timeout * 1000 + 2000);
      this.pending.set(cid, {
        resolve: (m) => { clearTimeout(timer); resolve(m); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(jstr({ type: "call", id: cid, name, args, timeout }));
    });
  }

  async waitEvent(pred, timeoutS = 15) {
    const deadline = Date.now() + timeoutS * 1000;
    while (Date.now() < deadline) {
      const ev = this.events.find(pred);
      if (ev) return ev;
      await sleep(200);
    }
    return null;
  }

  async close() {
    try { this.ws.close(); } catch {}
  }
}

async function main() {
  const chrome = chromeCandidates().find((c) => fs.existsSync(c));
  if (!chrome) {
    console.log("[SKIP] 未找到 Chrome/Edge");
    return 0;
  }

  // 1. 靶站
  const { server: target, port: tport } = await startTargetServer();
  const pageUrl = `http://${HOST}:${tport}/page.html`;

  // 2. daemon 子进程（独立端口，与日常浏览器隔离）
  const e2ePort = await freePort();
  const daemonLogPath = path.join(os.tmpdir(), "owb-e2e-daemon.log");
  // spawn stdio 要真实 fd（WriteStream 未 open 前 fd=null，Node 24 直接拒）
  const daemonLogFd = fs.openSync(daemonLogPath, "w");
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-chrome-"));
  // OWB_WORK_DIR：task/workflow/state 产物落临时目录，不污染仓库 work/
  const daemon = spawn(process.execPath, ["src/server.js"], {
    cwd: DAEMON_DIR,
    env: { ...process.env, OWB_PORT: String(e2ePort),
           OWB_WORK_DIR: path.join(tmpdir, "work") },
    stdio: ["ignore", daemonLogFd, daemonLogFd],
  });
  let chromeProc = null;
  let ctl = null, sub = null;
  try {
    if (!(await waitPort(e2ePort, 15))) {
      console.log("[FAIL] daemon 端口未就绪");
      return 1;
    }

    // 3. headless Chrome + 扩展副本（改写副本 background.js 的默认地址指向
    //    独立端口，防日常浏览器顶替；副本 storage 为空，默认地址即生效地址）
    const extCopy = path.join(tmpdir, "ext");
    fs.cpSync(EXT_DIR, extCopy, { recursive: true });
    const bgPath = path.join(extCopy, "background.js");
    const bgSrc = fs.readFileSync(bgPath, "utf8");
    const bgPatched = bgSrc.replace(
      /wsUrl: "ws:\/\/127\.0\.0\.1:\d+\/ws"/,
      `wsUrl: "ws://${HOST}:${e2ePort}/ws"`,
    );
    if (bgPatched === bgSrc) throw new Error("e2e: 未找到扩展默认 wsUrl，无法改写端口");
    fs.writeFileSync(bgPath, bgPatched, "utf8");
    chromeProc = spawn(chrome, [
      "--headless=new", "--disable-gpu", "--mute-audio",
      "--no-first-run", "--no-default-browser-check",
      "--no-sandbox",  // 跨用户目录运行 Chromium 时 sandbox 无法访问可执行文件
      "--silent-debugger-extension-api",
      `--user-data-dir=${tmpdir}`,
      `--load-extension=${extCopy}`,
      pageUrl,
    ], { stdio: "ignore" });

    // 4. 等扩展连接
    ctl = new Ctl(e2ePort);
    await ctl.connect();
    let extReady = false;
    for (let i = 0; i < 60; i++) {
      const res = await ctl.call("daemon.status");
      if (res.ok && res.data && res.data.extension_connected) {
        extReady = true;
        break;
      }
      await sleep(500);
    }
    check("扩展自动配对并连接 daemon", extReady);
    if (!extReady) return 1;

    // 5. 基础工具
    let res = await ctl.call("status");
    check("status: ws/helloAcked",
      res.ok && res.data && res.data.ws === 1 && res.data.helloAcked,
      jstr(res.data || {}));

    res = await ctl.call("evaluate", { expression: "location.pathname" });
    check("evaluate: 页面路径",
      res.ok && res.data && res.data.value === "/page.html",
      jstr(res.data || {}));

    // 6. Network 抓包 + initiator
    await ctl.call("network_start");
    res = await ctl.call("evaluate", {
      expression: "window.fireRequest()", awaitPromise: true });
    const firedSig = (res.data || {}).value;
    check("fireRequest 返回预期值", firedSig === EXPECTED_SIG,
      `${firedSig} vs ${EXPECTED_SIG}`);
    await sleep(500);
    res = await ctl.call("network_list", { url_pattern: "/api/data" });
    const items = (res.data || {}).requests || [];
    check("network_list 捕获 /api/data",
      items.length > 0 && items[0].status === 200,
      jstr(items));
    if (items.length > 0) {
      const rid = items[0].requestId;
      res = await ctl.call("get_initiator", { request_id: rid });
      const init = (res.data || {}).initiator;
      check("get_initiator 有调用栈",
        !!init && init.type === "script"
        && !!((init.stack || {}).callFrames || []).length,
        jstr(init).slice(0, 200));
      res = await ctl.call("network_detail", { request_id: rid });
      check("network_detail 有响应体",
        res.ok && String((res.data || {}).body).includes('"ok": true'),
        String((res.data || {}).body).slice(0, 100));
    }

    // 7. hook_preset(xhr)：注入 + reload + 事件流
    sub = new Ctl(e2ePort);
    await sub.connect(true);
    res = await ctl.call("hook_preset", { presets: ["xhr"] });
    check("hook_preset 注册+reload",
      res.ok && res.data && res.data.reloaded === true,
      jstr(res.data || {}));
    await sleep(2000);  // 等 reload 完成
    await ctl.call("evaluate", { expression: "void window.fireRequest()" });
    let ev = await sub.waitEvent(
      (e) => e.source === "hook:xhr" && (e.data || {}).phase === "request", 15);
    check("hook:xhr 捕获请求（含 X-Sign 头）",
      !!ev && ((ev.data || {}).headers || {})["X-Sign"] === EXPECTED_SIG,
      ev ? jstr(ev).slice(0, 200) : "no event");
    ev = await sub.waitEvent(
      (e) => e.source === "hook:xhr" && (e.data || {}).phase === "response", 10);
    check("hook:xhr 捕获响应（status 200）",
      !!ev && (ev.data || {}).status === 200);

    // 8. hook_function trace
    res = await ctl.call("hook_function", {
      function_path: "owbSign", position: "after",
      trace_args: true, trace_ret: true });
    check("hook_function 注册", !!res.ok, jstr(res.data || {}));
    await sleep(2000);
    await ctl.call("evaluate", { expression: "void window.fireRequest()" });
    ev = await sub.waitEvent(
      (e) => e.source === "hook:fn" && (e.data || {}).phase === "return", 15);
    check("hook:fn trace 捕获返回值",
      !!ev && (ev.data || {}).returnValue === EXPECTED_SIG,
      ev ? jstr(ev).slice(0, 200) : "no event");

    // 9. oracle_call 确定性样本
    res = await ctl.call("oracle_call", {
      function_path: "owbSign", call_args: ["payload1"], freeze: true });
    const oracle = res.data || {};
    check("oracle_call 确定性样本",
      oracle.ok && oracle.value === EXPECTED_SIG
      && (oracle.meta || {}).frozen === true,
      jstr(oracle));

    // 10. capture_request 宏工具
    res = await ctl.call("capture_request", {
      url_pattern: "/api/data",
      trigger: { expression: "void window.fireRequest()" } });
    const pack = res.data || {};
    check("capture_request 证据包",
      !!((pack.request || {}).requestId)
      && (pack.request || {}).status === 200
      && !!pack.initiator,
      jstr(res).slice(0, 300));

    // 11. break_xhr + frame_read（frozen-snapshot）
    // ⚠️ setXHRBreakpoint 会在 xhr.send 内同步暂停页面，Runtime.evaluate 的
    // 响应要等 resume 后才返回；而 daemon 对单连接顺序处理消息，所以触发请求
    // 的 evaluate 必须走独立连接 + 后台 promise，否则 evaluate 等 resume、
    // frame_read 等 evaluate 形成死锁（e2e 实测踩坑）。
    await ctl.call("break_xhr", { url_substring: "/api/data" });
    const ctl2 = new Ctl(e2ePort);
    await ctl2.connect();
    const fireP = ctl2.call("evaluate", { expression: "void window.fireRequest()" });
    fireP.catch(() => {});  // 结果不作硬检查，防未处理 rejection
    ev = await sub.waitEvent(
      (e) => e.source === "debugger" && (e.data || {}).phase === "paused", 15);
    check("break_xhr 暂停事件", !!ev,
      ev ? jstr(ev).slice(0, 200) : "no paused event");
    res = await ctl.call("frame_read", { max_frames: 3 });
    const fr = res.data || {};
    check("frame_read 读帧并自动 resume",
      !!((fr.frames || []).length) && fr.resumed === true,
      jstr(res).slice(0, 300));
    try {  // resume 后 evaluate 应完成；结果不作为硬检查项
      await withTimeout(fireP, 15000);
    } catch {}
    await ctl2.close();
    await ctl.call("break_remove", {});

    // 12. export_state / import_state 往返
    res = await ctl.call("export_state");
    const state = res.data;
    check("export_state", !!state && "storage" in state);
    res = await ctl.call("import_state", { state });
    check("import_state", res.ok && "storage" in (res.data || {}));

    // 13. env_compare
    res = await ctl.call("env_compare");
    const batches = (res.data || {}).batches || {};
    const ua = (batches.navigator || {})["navigator.userAgent"] || "";
    check("env_compare 采集 UA", ua.includes("Chrome"), ua.slice(0, 80));

    // 14. 脚本源码感知（script_list / script_source / search_code）
    res = await ctl.call("script_list", { url_pattern: "page\\.html" });
    const scripts = (res.data || {}).scripts || [];
    const sid = scripts.length > 0 ? scripts[0].scriptId : null;
    check("script_list 找到靶站脚本", !!sid,
      jstr(scripts).slice(0, 200));
    res = await ctl.call("script_source", { script_id: sid });
    const src = (res.data || {}).source || "";
    check("script_source 拉源码", src.includes("owbSign"), `len=${src.length}`);
    res = await ctl.call("search_code", { query: "owbSign", url_pattern: "page\\.html" });
    check("search_code 定位函数",
      res.ok && ((res.data || {}).count || 0) >= 1,
      jstr(res.data).slice(0, 200));

    // 15. break_function→ paused → frame_read → break_remove
    res = await ctl.call("break_function", { function_path: "owbSign" });
    check("break_function 注册",
      res.ok && (res.data || {}).armed === "fn:owbSign",
      jstr(res).slice(0, 200));
    const ctl3 = new Ctl(e2ePort);
    await ctl3.connect();
    sub.events.length = 0;  // 清掉 break_xhr 阶段的旧 paused 事件，防误匹配
    const fire2 = ctl3.call("evaluate", { expression: "void window.fireRequest()" });
    fire2.catch(() => {});
    ev = await sub.waitEvent(
      (e) => e.source === "debugger" && (e.data || {}).phase === "paused", 15);
    check("break_function 暂停事件", !!ev,
      ev ? jstr(ev).slice(0, 200) : "no paused event");
    res = await ctl.call("frame_read", { max_frames: 2 });
    check("break_function frame_read 自动 resume",
      !!(((res.data || {}).frames || []).length)
      && (res.data || {}).resumed === true,
      jstr(res).slice(0, 200));
    try {
      await withTimeout(fire2, 15000);
    } catch {}
    await ctl3.close();
    await ctl.call("break_remove", {});

    // 16. cookie 三件套
    res = await ctl.call("cookie_set", { name: "owb_e2e", value: "1" });
    check("cookie_set",
      res.ok && (res.data || {}).success === true,
      jstr(res).slice(0, 200));
    res = await ctl.call("cookie_get", {});
    let names = ((res.data || {}).cookies || []).map((c) => c.name);
    check("cookie_get 读回", names.includes("owb_e2e"), names.join(",").slice(0, 120));
    await ctl.call("cookie_delete", { name: "owb_e2e" });
    res = await ctl.call("cookie_get", {});
    names = ((res.data || {}).cookies || []).map((c) => c.name);
    check("cookie_delete 删除", !names.includes("owb_e2e"), names.join(",").slice(0, 120));

    // 17. screenshot / cdp 逃生舱 / fill
    res = await ctl.call("screenshot", { format: "jpeg", quality: 60 });
    check("screenshot 截图",
      res.ok && ((res.data || {}).dataLength || 0) > 1000,
      `len=${(res.data || {}).dataLength}`);
    res = await ctl.call("cdp", { method: "Runtime.evaluate",
      params: { expression: "1+1", returnByValue: true } });
    const val = ((((res.data || {}).result || {}).result || {})).value;
    check("cdp 逃生舱", val === 2, jstr(res).slice(0, 200));
    await ctl.call("evaluate", { expression:
      "const i=document.createElement('input');i.id='owb-t';"
      + "document.body.appendChild(i);'ok'" });
    res = await ctl.call("fill", { selector: "#owb-t", value: "hello-owb" });
    const res2 = await ctl.call("evaluate", { expression: "document.querySelector('#owb-t').value" });
    check("fill 填值（native setter）",
      res.ok && (res2.data || {}).value === "hello-owb",
      jstr(res2).slice(0, 120));

    // 18. hook_preset fetch 预设
    await ctl.call("hook_preset", { presets: ["fetch"] });
    await sleep(2000);  // 等 reload 完成
    await ctl.call("evaluate", { expression:
      "void fetch('/api/data?sig=fetchprobe', {method: 'POST', body: '{}'})" });
    ev = await sub.waitEvent(
      (e) => e.source === "hook:fetch" && jstr(e).includes("fetchprobe"), 15);
    check("hook:fetch 捕获请求", !!ev,
      ev ? jstr(ev).slice(0, 200) : "no hook:fetch event");

    // 19. OWB 标签分组（navigate new_tab 自动编组 + close_group 清场）
    res = await ctl.call("navigate", { url: pageUrl, new_tab: true });
    const gid = (res.data || {}).groupId;
    const newTid = (res.data || {}).tabId;
    check("navigate new_tab 自动编组", !!gid && !!newTid,
      jstr(res).slice(0, 200));
    res = await ctl.call("list_tabs", {});
    const grouped = ((res.data || {}).tabs || []).filter((t) => t.group === "OWB 临时");
    check("list_tabs 可见 OWB 分组",
      grouped.some((t) => t.tabId === newTid),
      jstr(grouped).slice(0, 200));
    res = await ctl.call("close_group", {});
    const closed = (res.data || {}).closed || 0;
    const res3 = await ctl.call("list_tabs", {});
    const still = ((res3.data || {}).tabs || []).filter((t) => t.tabId === newTid);
    check("close_group 清场", closed >= 1 && still.length === 0, `closed=${closed}`);

    // 20. wait_for / read_page（稳定 ref）/ ref 操作 / task_context
    res = await ctl.call("wait_for", { selector: "#btn1" });
    check("wait_for selector 立即命中",
      res.ok && res.data && res.data.condition === "selector"
      && res.data.tag === "BUTTON",
      jstr(res.data || {}).slice(0, 200));
    res = await ctl.call("wait_for", { text: "迟到元素", timeout_ms: 8000 });
    check("wait_for text 命中迟到元素",
      res.ok && res.data && res.data.condition === "text",
      jstr(res).slice(0, 200));
    res = await ctl.call("wait_for", { selector: "#no-such-el", timeout_ms: 1500 });
    check("wait_for 超时错误码 TIMEOUT",
      res.ok === false && (res.error || {}).code === "TIMEOUT",
      jstr(res).slice(0, 200));
    res = await ctl.call("wait_for", { selector: "#a", text: "b" });
    check("wait_for 多条件 BAD_ARGS",
      res.ok === false && (res.error || {}).code === "BAD_ARGS",
      jstr(res).slice(0, 200));

    res = await ctl.call("read_page", { mode: "snapshot" });
    const snap = res.data || {};
    const nodes = snap.nodes || [];
    const btnNode = nodes.find((n) => n.role === "button"
      && (n.name || "").includes("搜索"));
    const iptNode = nodes.find((n) => n.role === "textbox"
      && (n.name || "") === "关键词");
    const btnRef = (btnNode || {}).ref;
    const iptRef = (iptNode || {}).ref;
    check("read_page snapshot 含按钮行与 @e ref",
      !!btnRef && (snap.lines || "").includes(`@${btnRef} button`) && !!iptRef,
      (snap.lines || "").slice(0, 200));

    res = await ctl.call("click", { ref: "@" + btnRef });
    const res4 = await ctl.call("evaluate", { expression: "!!document.querySelector('#clicked-mark')" });
    check("click({ref}) 生效",
      res.ok && (res4.data || {}).value === true,
      jstr(res).slice(0, 200));
    res = await ctl.call("fill", { ref: iptRef, value: "你好关键词" });
    const res5 = await ctl.call("evaluate", { expression: "document.querySelector('#ipt1').value" });
    check("fill({ref}) 生效",
      res.ok && (res5.data || {}).value === "你好关键词",
      jstr(res5).slice(0, 120));
    res = await ctl.call("click", { ref: "@e999" });
    check("click 失效 ref 抛 REF_STALE",
      res.ok === false && (res.error || {}).code === "REF_STALE",
      jstr(res).slice(0, 200));

    res = await ctl.call("read_page", { mode: "snapshot", since_last: true });
    const stats = (res.data || {}).stats || {};
    check("read_page since_last 第二次基本 unchanged",
      stats.added === 0 && stats.changed === 0 && (stats.unchanged || 0) >= 2,
      jstr(stats));

    res = await ctl.call("read_page", { mode: "article" });
    const content = (res.data || {}).content || "";
    check("read_page article 含预期段落",
      content.includes("第一段正文内容") && content.includes("第二段正文内容")
      && content.includes("# 靶站文章"),
      content.slice(0, 200));

    res = await ctl.call("task_context", { title: "e2e任务" });
    check("task_context set",
      res.ok && (res.data || {}).taskSet === true,
      jstr(res).slice(0, 200));
    res = await ctl.call("navigate", { url: pageUrl, new_tab: true });
    const taskTid = (res.data || {}).tabId;
    res = await ctl.call("list_tabs", {});
    const grp = ((res.data || {}).tabs || []).find((t) => t.tabId === taskTid) || {};
    check("navigate new_tab 入 task 组",
      grp.group === "task: e2e任务",
      jstr(grp).slice(0, 200));
    res = await ctl.call("task_context", { action: "clear" });
    const cleared = res.data || {};
    check("task_context clear 返回 tabCount",
      cleared.cleared === true && (cleared.tabCount || 0) >= 1
      && (cleared.tabIds || []).includes(taskTid),
      jstr(cleared).slice(0, 200));
    res = await ctl.call("navigate", { url: pageUrl, new_tab: true });
    const taskTid2 = (res.data || {}).tabId;
    res = await ctl.call("list_tabs", {});
    const grp2 = ((res.data || {}).tabs || []).find((t) => t.tabId === taskTid2) || {};
    check("clear 后 navigate 回 OWB 组", grp2.group === "OWB 临时",
      jstr(grp2).slice(0, 200));
    for (const tid of [taskTid, taskTid2]) {  // 清场，别留在用户浏览器里
      await ctl.call("close_tab", { tabId: tid });
    }

    // 21. mouse_click（真实鼠标 + AI 光标）/ handoff / wait_user
    res = await ctl.call("navigate", { url: pageUrl, new_tab: true });
    const v5Tid = (res.data || {}).tabId;
    check("开靶站 tab", res.ok && !!v5Tid,
      jstr(res).slice(0, 200));

    res = await ctl.call("mouse_click", { tabId: v5Tid, selector: "#btn2" });
    const mc = res.data || {};
    const res6 = await ctl.call("evaluate", { tabId: v5Tid,
      expression: "JSON.stringify(window.__owbTrust || null)" });
    let trust = null;
    try { trust = JSON.parse((res6.data || {}).value || "null"); } catch {}
    check("mouse_click(selector) 真实鼠标（isTrusted）+ 返回坐标",
      res.ok && mc.clicked === "#btn2"
      && typeof mc.x === "number" && typeof mc.y === "number"
      && !!trust && trust.trusted === true,
      jstr(res).slice(0, 250));

    res = await ctl.call("read_page", { tabId: v5Tid, mode: "snapshot" });
    const nodes5 = (res.data || {}).nodes || [];
    const btn5 = nodes5.find((n) => n.role === "button"
      && (n.name || "").includes("搜索"));
    const ref5 = (btn5 || {}).ref;
    res = await ctl.call("mouse_click", { tabId: v5Tid, ref: "@" + ref5 });
    const res7 = await ctl.call("evaluate", { tabId: v5Tid,
      expression: "!!document.querySelector('#clicked-mark')" });
    check("mouse_click(ref) 点击生效",
      res.ok && (res.data || {}).clicked === "@" + ref5
      && (res7.data || {}).value === true,
      jstr(res).slice(0, 250));
    res = await ctl.call("mouse_click", { tabId: v5Tid, selector: "#no-such-el" });
    check("mouse_click 不存在 selector 报 NOT_FOUND",
      res.ok === false && (res.error || {}).code === "NOT_FOUND",
      jstr(res).slice(0, 200));

    res = await ctl.call("handoff", { tabId: v5Tid, reason: "e2e 需要用户操作" });
    const ho = res.data || {};
    check("handoff 交还 tab",
      res.ok && ho.handedOff === true && !!ho.url,
      jstr(res).slice(0, 200));
    res = await ctl.call("list_tabs", {});
    const hgrp = ((res.data || {}).tabs || []).find((t) => t.tabId === v5Tid) || {};
    check("handoff tab 入「等你操作」组",
      (hgrp.group || "").includes("等你操作"),
      jstr(hgrp).slice(0, 200));
    ev = await sub.waitEvent(
      (e) => e.source === "handoff" && (e.data || {}).phase === "waiting", 5);
    check("handoff 推送 waiting 事件", !!ev,
      ev ? jstr(ev).slice(0, 200) : "no event");

    // wait_user url_change：独立连接挂起等待（单连接消息顺序处理，同连会自锁），
    // 主连接 1s 后改 href 模拟用户接管；daemon 侧 timeout 须 ≥ timeout_ms/1000 + 10
    sub.events.length = 0;
    const ctl4 = new Ctl(e2ePort);
    await ctl4.connect();
    const waitP = ctl4.call("wait_user",
      { tabId: v5Tid, condition: "url_change", timeout_ms: 15000 }, 25);
    waitP.catch(() => {});
    await sleep(1000);
    await ctl.call("evaluate", { tabId: v5Tid,
      expression: "location.href = " + jstr(pageUrl + "?tookover=1") });
    try {
      res = await withTimeout(waitP, 30000);
    } catch (e) {
      res = { ok: false, error: { code: "TEST_ERROR", message: String((e && e.message) || e) } };
    }
    const wu = res.data || {};
    check("wait_user url_change 接管成功",
      res.ok && wu.tookOver === true
      && (wu.url || "").includes("tookover=1"),
      jstr(res).slice(0, 250));
    res = await ctl.call("list_tabs", {});
    const hgrp2 = ((res.data || {}).tabs || []).find((t) => t.tabId === v5Tid) || {};
    check("wait_user 命中后 tab 出组（clear）",
      !hgrp2.group,
      jstr(hgrp2).slice(0, 200));
    ev = await sub.waitEvent(
      (e) => e.source === "handoff" && (e.data || {}).phase === "resolved", 5);
    check("wait_user 推送 resolved 事件", !!ev,
      ev ? jstr(ev).slice(0, 200) : "no event");

    res = await ctl.call("wait_user",
      { tabId: v5Tid, condition: "selector", selector: "#never-exists", timeout_ms: 2000 },
      10);
    check("wait_user 超时报 TIMEOUT",
      res.ok === false && (res.error || {}).code === "TIMEOUT",
      jstr(res).slice(0, 200));
    await ctl4.close();
    await ctl.call("close_tab", { tabId: v5Tid });

    // 22. daemon 侧：task 审计 → workflow 录制/回放 + state 存档
    res = await ctl.call("daemon.task_begin", { title: "e2e-workflow" });
    const taskId = (res.data || {}).task_id;
    check("daemon.task_begin", res.ok && !!taskId,
      jstr(res).slice(0, 200));
    res = await ctl.call("navigate", { url: pageUrl, new_tab: true });
    const wfTid = (res.data || {}).tabId;
    await ctl.call("evaluate", { tabId: wfTid, expression: "1+1" });
    await ctl.call("evaluate", { tabId: wfTid, expression: "2+2" });
    res = await ctl.call("daemon.task_end");
    check("daemon.task_end", !!res.ok,
      jstr(res).slice(0, 200));

    res = await ctl.call("daemon.workflow_save", { name: "e2e-flow", task_id: taskId });
    check("workflow_save step_count>=2",
      res.ok && (((res.data || {}).step_count) || 0) >= 2,
      jstr(res).slice(0, 250));
    res = await ctl.call("daemon.workflow_run", { name: "e2e-flow" }, 120);
    const wfr = res.data || {};
    check("workflow_run 每步 ok",
      res.ok && wfr.failed === 0
      && !!((wfr.results || []).length)
      && wfr.results.every((r) => r.ok),
      jstr(res).slice(0, 300));
    res = await ctl.call("daemon.workflow_list", {});
    const wfNames = ((res.data || {}).workflows || []).map((w) => w.name);
    check("workflow_list 含 e2e-flow", wfNames.includes("e2e-flow"),
      wfNames.join(","));
    res = await ctl.call("daemon.state_save", { name: "e2e-state", tabId: wfTid });
    const origin = (res.data || {}).origin || "";
    check("state_save summary 含 origin",
      res.ok && origin.includes("127.0.0.1"),
      jstr(res).slice(0, 250));
    res = await ctl.call("daemon.state_list", {});
    const snames = ((res.data || {}).states || []).map((s) => s.name);
    check("state_list 含 e2e-state", snames.includes("e2e-state"),
      snames.join(","));
    res = await ctl.call("daemon.state_load", { name: "e2e-state", tabId: wfTid });
    check("state_load ok", !!res.ok,
      jstr(res).slice(0, 250));
    // workflow_run 重放 navigate 会再开 tab（入 OWB 组），连同任务 tab 一起清场
    await ctl.call("close_group", {});
    if (wfTid) await ctl.call("close_tab", { tabId: wfTid });

    await ctl.close();
    await sub.close();
  } finally {
    if (chromeProc) await killProc(chromeProc);
    await killProc(daemon);
    target.close();
    fs.closeSync(daemonLogFd);
    fs.rmSync(tmpdir, { recursive: true, force: true });
  }

  return summarize();
}

if (isMainModule(import.meta.url)) {
  main().then((rc) => process.exit(rc)).catch((e) => {
    console.error("[FAIL] 测试异常:", e);
    process.exit(1);
  });
}

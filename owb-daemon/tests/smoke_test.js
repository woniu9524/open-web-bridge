/**
 * 无浏览器端到端冒烟测试：mock 扩展 + 真 daemon 子进程 + 控制器。
 *
 * 覆盖：
 *   1. 握手：非 hello 首帧被拒（4400）；hello 无需 token
 *   2. 安全：http Origin 被拒（4403，防 DNS rebinding）
 *   3. 工具路由：ctl call → 扩展收到 tool_call → tool_result 回到 ctl
 *   4. event 推流：扩展 event → daemon 分配 seq → 订阅者收到；断线补拉 since_seq
 *   5. 失败路径：扩展断开时 pending call 返回 DISCONNECTED
 *   6. session 审计与事件落盘
 *   7. task 归档：task_begin/end/list + task 目录归档（无扩展 ext_sync=false）
 *   8. 宏回放与会话库：workflow_save NEED_TASK → 录制 → 固化/重放/列表，
 *      state_save 无扩展透传失败、state_list 空库
 *
 * 自我端口隔离：挑空闲端口 spawn `node src/server.js`
 * （OWB_PORT + OWB_WORK_DIR=临时目录），跑完杀子进程。
 *
 * 运行：cd owb-daemon && node tests/smoke_test.js
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { HOST, makeChecker, freePort, waitPort, killProc, onceOpen, tk } from "./kit.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_DIR = path.resolve(__dirname, "..");

const { check, summarize } = makeChecker();

const jstr = (o) => JSON.stringify(o);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function recvJson(ws, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("recv timeout")); }, timeoutMs);
    function onMsg(data) { cleanup(); try { resolve(JSON.parse(data.toString())); } catch (e) { reject(e); } }
    function onErr(e) { cleanup(); reject(e); }
    function cleanup() { clearTimeout(timer); ws.off("message", onMsg); ws.off("error", onErr); }
    ws.on("message", onMsg);
    ws.on("error", onErr);
  });
}

// 连上（可选发一帧）后等 daemon 主动关闭，回关闭码；超时不关回 null
async function connectExpectClose(url, firstFrame = null, opts = {}) {
  const ws = new WebSocket(url, opts);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { try { ws.terminate(); } catch {} resolve(null); }, 5000);
    ws.on("open", () => { if (firstFrame) ws.send(jstr(firstFrame)); });
    ws.on("error", () => {}); // error 后必有 close，这里只关心关闭码
    ws.on("close", (code) => { clearTimeout(timer); resolve(code); });
  });
}

// 轮询直到 fn() 返回真值（落盘等异步副作用用）
async function waitFor(fn, timeoutMs = 5000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { last = fn(); } catch { last = null; }
    if (last) return last;
    await sleep(intervalMs);
  }
  return last || null;
}

class MockExtension {
  /** 模拟扩展：hello 握手 + 应答 tool_call + 推 event。 */
  constructor(port, token = null) {
    this.port = port;
    this.token = token;
    this.ws = null;
    this._handler = null;
  }

  async connect() {
    this.ws = new WebSocket(tk(`ws://${HOST}:${this.port}/ws`, this.token));
    this.ws.on("error", () => {});  // 长连接常驻兜底，防 EventEmitter 无监听抛异常
    await onceOpen(this.ws);
    this.ws.send(jstr({
      type: "hello",
      payload: { client: "open-web-bridge-extension", version: "0.0.0" },
    }));
    const ack = await recvJson(this.ws);
    if (ack.type !== "hello_ack") throw new Error("bad ack: " + jstr(ack));
  }

  serve() {
    this._handler = (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === "ping") {
        this.ws.send(jstr({ type: "pong", payload: {} }));
      } else if (msg.type === "tool_call") {
        const name = msg.payload.name;
        const payload = name === "status"
          ? { ok: true, data: { ws: 1, attachedTabs: [111], mock: true } }
          : { ok: false, error: { code: "UNKNOWN_TOOL", message: name, retryable: false } };
        // UX-51 用：slow_ms 让这一条应答故意拖慢，验证它不会堵住后面的调用
        const delay = Number((msg.payload.args || {}).slow_ms) || 0;
        const reply = () =>
          this.ws.send(jstr({ type: "tool_result", requestId: msg.requestId, payload }));
        if (delay) setTimeout(reply, delay); else reply();
      }
    };
    this.ws.on("message", this._handler);
  }

  stop() {  // 停掉应答循环
    if (this._handler) { this.ws.off("message", this._handler); this._handler = null; }
  }

  emitEvent(source, data) {
    this.ws.send(jstr({ type: "event", payload: { source, data } }));
  }
}

async function ctlCall(ws, name, args = {}, cid = "c1") {
  ws.send(jstr({ type: "call", id: cid, name, args }));
  for (;;) {
    const msg = await recvJson(ws);
    if (msg.type === "result" && msg.id === cid) return msg;
  }
}

function ctlConnect(port, token = null) {
  const ws = new WebSocket(tk(`ws://${HOST}:${port}/ctl`, token));
  ws.on("error", () => {});  // 长连接常驻兜底
  return onceOpen(ws).then(() => ws);
}

async function main() {
  const port = await freePort();
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-test-"));
  const daemon = spawn(process.execPath, ["src/server.js"], {
    cwd: DAEMON_DIR,
    env: { ...process.env, OWB_PORT: String(port), OWB_WORK_DIR: workdir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let daemonLog = "";
  daemon.stdout.on("data", (d) => { daemonLog += d; });
  daemon.stderr.on("data", (d) => { daemonLog += d; });

  let ctl = null, ctl2 = null, ctl3 = null;
  try {
    if (!(await waitPort(port, 15))) {
      check("daemon 端口就绪", false, daemonLog.slice(-500));
      return 1;
    }

    // 0. 无 token 认证：直连可用（本地信任模型）
    let code = await connectExpectClose(`ws://${HOST}:${port}/ws`, null);
    check("无 token 直连 /ws 可达（非 4401）", code !== 4401, `code=${code}`);
    code = await connectExpectClose(`ws://${HOST}:${port}/ctl?token=stale`, null);
    check("带残留 token 参数仍可连（参数被忽略）", code !== 4401, `code=${code}`);

    // 1. 非 hello 首帧被拒
    code = await connectExpectClose(`ws://${HOST}:${port}/ws`,
      { type: "nope", payload: {} });
    check("非 hello 首帧拒绝", code === 4400, `code=${code}`);

    // 1b. 误连拒绝：其他桥的扩展（client 标识不符，如 kimi-webbridge 碰巧同端口）
    code = await connectExpectClose(`ws://${HOST}:${port}/ws`,
      { type: "hello", payload: { extensionVersion: "9.9.9" } });
    check("异族扩展误连拒绝", code === 4400, `code=${code}`);

    // 2. http Origin 被拒（防 DNS rebinding）
    code = await connectExpectClose(`ws://${HOST}:${port}/ws`, null,
      { headers: { Origin: "https://evil.example.com" } });
    check("http Origin 拒绝", code === 4403, `code=${code}`);

    // 3. mock 扩展握手 + 工具路由
    const ext = new MockExtension(port);
    await ext.connect();
    ext.serve();
    check("扩展 hello 握手", true);

    ctl = await ctlConnect(port);
    let res = await ctlCall(ctl, "status");
    check("工具路由 status",
      res.ok && res.data && res.data.mock === true,
      jstr(res));

    res = await ctlCall(ctl, "nonexistent_tool");
    check("未知工具 error model",
      !res.ok && res.error && res.error.code === "UNKNOWN_TOOL"
      && res.error.retryable === false,
      jstr(res));

    // 3.5 daemon 本地工具（不经浏览器）
    res = await ctlCall(ctl, "daemon.status");
    check("daemon.status 本地路由",
      res.ok && res.data && res.data.extension_connected === true,
      jstr(res));
    res = await ctlCall(ctl, "daemon.evidence_write",
      { path: "test/probe.json", content: { hello: "owb" } });
    check("daemon.evidence_write 落盘",
      res.ok && res.data && String(res.data.path).includes("probe.json"),
      jstr(res));
    res = await ctlCall(ctl, "daemon.no_such");
    check("daemon 未知本地工具",
      !res.ok && res.error && res.error.code === "UNKNOWN_TOOL");

    // 4. event 推流 + seq + 补拉
    ctl.send(jstr({ type: "subscribe" }));
    await recvJson(ctl);  // subscribed
    ext.emitEvent("network", { tabId: 111, url: "https://a.example/api" });
    ext.emitEvent("hook:xhr", { tabId: 111, hit: "sign=abc" });
    const ev1 = await recvJson(ctl);
    const ev2 = await recvJson(ctl);
    check("event 推流带单调 seq",
      ev1.seq === 1 && ev2.seq === 2 && ev2.source === "hook:xhr",
      jstr([ev1, ev2]));

    // 新控制器按 since_seq 补拉
    ctl2 = await ctlConnect(port);
    ctl2.send(jstr({ type: "events", since_seq: 1 }));
    const replay = await recvJson(ctl2);
    check("event 断线补拉", replay.seq === 2, jstr(replay));

    // 4b. 订阅过滤：sources 白名单 + url_pattern
    ctl3 = await ctlConnect(port);
    ctl3.send(jstr({ type: "subscribe", sources: ["hook:xhr"] }));
    const subAck = await recvJson(ctl3);
    check("subscribe 过滤器回执",
      subAck.type === "subscribed"
      && jstr((subAck.filter || {}).sources) === jstr(["hook:xhr"]),
      jstr(subAck));
    ctl3.send(jstr({ type: "subscribe", sources: ["hook:xhr"], url_pattern: "sign" }));
    await recvJson(ctl3);  // subscribed（覆盖上一个过滤器）
    ext.emitEvent("network", { tabId: 111, url: "https://a.example/x" });
    ext.emitEvent("hook:xhr", { tabId: 111, url: "https://a.example/api?other=1" });
    ext.emitEvent("hook:xhr", { tabId: 111, url: "https://a.example/api?sign=abc" });
    const fev = await recvJson(ctl3);
    check("订阅过滤 sources+url_pattern",
      fev.source === "hook:xhr" && jstr(fev).includes("sign=abc") && fev.seq === 5,
      jstr(fev));

    // 4c. daemon.hook_logs 取证
    res = await ctlCall(ctl, "daemon.hook_logs", { limit: 10 });
    const hits = (res.data || {}).events || [];
    check("daemon.hook_logs 只回 hook 事件",
      res.ok && hits.length === 3 && hits.every((h) => h.source === "hook:xhr"),
      `count=${hits.length}`);
    res = await ctlCall(ctl, "daemon.hook_logs", { since_seq: 4 });
    check("daemon.hook_logs since_seq 过滤",
      res.ok && res.data && res.data.events && res.data.events.length === 1,
      jstr((res.data || {}).events));

    // 4d. evidence_write 路径穿越防护
    res = await ctlCall(ctl, "daemon.evidence_write", { path: "../evil.txt", content: "x" });
    check("evidence_write 路径穿越拒绝", !res.ok, jstr(res));

    // 4e. ctl call 超时参数透传（mock 即时应答，验证字段被接受即可）
    ctl.send(jstr({ type: "call", id: "ct", name: "status", args: {}, timeout: 5 }));
    for (;;) {  // ctl 也订阅了事件流，跳过 event 帧
      res = await recvJson(ctl);
      if (res.type === "result" && res.id === "ct") break;
    }
    check("ctl timeout 字段", res.ok && res.id === "ct", jstr(res));
    ctl3.close();

    // 5. 扩展断开 → pending call 返回 DISCONNECTED
    // 先停掉 mock 的应答循环，保证 tool_call 发出后无人应答
    ext.stop();
    const pending = ctlCall(ctl, "status", {}, "c2");
    pending.catch(() => {});  // 兜底，结果由下方 await 处理
    await sleep(200);  // 确保 tool_call 已送达 daemon
    ext.ws.close();
    res = await pending;
    check("扩展断开 pending 失败返回",
      !res.ok && res.error && ["DISCONNECTED", "SEND_FAILED"].includes(res.error.code),
      jstr(res));

    // 6. session 审计落盘 + 事件**默认不落盘**
    // events 磁盘日志曾经是无轮转无上限的裸追加流，实测长到 18 GiB，而
    // 没有任何代码读回它（events / hook_logs 都读内存 ring buffer）。现在
    // 默认关闭，OWB_EVENTS_LOG=1 才写；写入器本身由 rolling_log_test 覆盖。
    // 这里守住策略：跑完 5 个事件后，磁盘上不该出现任何 events 分片。
    await sleep(300);
    const evDir = path.join(workdir, "events");
    const evFiles = fs.existsSync(evDir)
      ? fs.readdirSync(evDir).filter((x) => x.endsWith(".jsonl"))
      : [];
    check("event 默认不落盘（OWB_EVENTS_LOG 未开）", evFiles.length === 0,
      `files=${JSON.stringify(evFiles)}`);
    const sessionText = await waitFor(() => {
      const dir = path.join(workdir, "sessions");
      if (!fs.existsSync(dir)) return null;
      const f = fs.readdirSync(dir).filter((x) => x.endsWith(".jsonl")).sort()[0];
      if (!f) return null;
      const text = fs.readFileSync(path.join(dir, f), "utf8");
      return text.includes("tool_call") ? text : null;
    });
    check("session 审计落盘", !!sessionText && sessionText.includes("tool_call"));
    // daemon.* 本地调用也要进审计
    check("daemon.* 调用审计落盘", !!sessionText && sessionText.includes('"ctl->"'));

    // 7. task 归档：扩展已在第 5 步断开，ext_sync 应为 false
    res = await ctlCall(ctl, "daemon.task_begin", { title: "smoke probe" });
    const task = res.data || {};
    const taskId = task.task_id || "";
    check("daemon.task_begin 无扩展 ext_sync=False",
      res.ok && task.ext_sync === false && task.dir === `tasks/${taskId}`,
      jstr(res));
    res = await ctlCall(ctl, "daemon.status");
    check("daemon.status 带 current_task",
      res.ok && res.data && res.data.current_task === taskId,
      jstr((res.data || {}).current_task));
    res = await ctlCall(ctl, "daemon.evidence_write",
      { path: `tasks/${taskId}/notes.md`, content: "# probe" });
    check("task 目录内 evidence_write",
      res.ok && res.data && String(res.data.path).includes("notes.md"),
      jstr(res));
    res = await ctlCall(ctl, "daemon.task_end");
    const summary = res.data || {};
    const meta = await waitFor(() => {
      const p = path.join(workdir, "tasks", taskId, "task.json");
      if (!fs.existsSync(p)) return null;
      const m = JSON.parse(fs.readFileSync(p, "utf8"));
      return m.ended_at ? m : null;
    }) || {};
    check("daemon.task_end 摘要落盘",
      res.ok && "event_count" in summary && summary.group === null
      && meta.ended_at && meta.id === taskId,
      jstr(summary));
    res = await ctlCall(ctl, "daemon.task_list");
    const tasks = (res.data || {}).tasks || [];
    check("daemon.task_list 含该任务且 current 清空",
      res.ok && tasks.some((t) => t.id === taskId)
      && res.data && res.data.current === null,
      jstr(res.data));
    res = await ctlCall(ctl, "daemon.task_end");
    check("无活动任务 task_end 报 NO_TASK",
      !res.ok && res.error && res.error.code === "NO_TASK"
      && res.error.retryable === false,
      jstr(res));

    // 7b. 并发场景：多个调用方共享同一个 Bridge 单例时，后开的 task_begin 会
    // 顶替 current_task 全局指针——task_end 现在应该认 args.task_id，让先开的
    // 那个任务能精确结束自己，而不是打偏（关掉别人）或扑空（NO_TASK）。
    res = await ctlCall(ctl, "daemon.task_begin", { title: "concurrent A" });
    const taskA = (res.data || {}).task_id || "";
    res = await ctlCall(ctl, "daemon.task_begin", { title: "concurrent B" });
    const taskB = (res.data || {}).task_id || "";
    check("并发：后开的 task_begin 顶替 current_task",
      taskA && taskB && taskA !== taskB, `A=${taskA} B=${taskB}`);
    res = await ctlCall(ctl, "daemon.task_end", { task_id: taskA });
    check("并发：显式 task_id 结束非当前任务不报错",
      res.ok && res.data && res.data.id === taskA && res.data.ended_stale === true,
      jstr(res));
    res = await ctlCall(ctl, "daemon.status");
    check("并发：结束旧任务不清掉别人的 current_task",
      res.ok && res.data && res.data.current_task === taskB,
      jstr((res.data || {}).current_task));
    res = await ctlCall(ctl, "daemon.task_end");
    check("并发：裸 task_end 仍能正常收尾真正的当前任务",
      res.ok && res.data && res.data.id === taskB && !res.data.ended_stale,
      jstr(res));
    res = await ctlCall(ctl, "daemon.status");
    check("并发：当前任务结束后 current_task 清空",
      res.ok && res.data && res.data.current_task === null,
      jstr((res.data || {}).current_task));

    // 8. 宏回放与会话库（无扩展场景）
    // 8a. 无任务时 workflow_save 报 NEED_TASK
    res = await ctlCall(ctl, "daemon.workflow_save", { name: "nothing" });
    check("workflow_save 无任务 NEED_TASK",
      !res.ok && res.error && res.error.code === "NEED_TASK"
      && res.error.retryable === false,
      jstr(res));
    // 8b. task_begin 包住录制窗口（扩展不在线 ext_sync=false）
    res = await ctlCall(ctl, "daemon.task_begin", { title: "macro rec" });
    const recTask = res.data || {};
    const recTaskId = recTask.task_id || "";
    check("录制任务 task_begin ext_sync=False",
      res.ok && recTask.ext_sync === false,
      jstr(res));
    // 8c. 重连 mock 扩展，经 ctl 发 3 个会被审计（ext-> tool_call）的调用
    const ext2 = new MockExtension(port);
    await ext2.connect();
    ext2.serve();
    for (let i = 0; i < 3; i++) {
      res = await ctlCall(ctl, "status", {}, `rec${i}`);
      check(`录制调用 status#${i}`, !!res.ok, jstr(res));
    }
    // 8d. 断扩展 → task_end → workflow_save 按 task_id 固化
    ext2.stop();
    ext2.ws.close();
    await sleep(300);  // 等 daemon 登记断开
    res = await ctlCall(ctl, "daemon.task_end");
    check("录制任务 task_end", !!res.ok, jstr(res));
    await sleep(200);  // 等 session 审计落盘（workflow_save 要读）
    res = await ctlCall(ctl, "daemon.workflow_save",
      { name: "Smoke Macro!!", task_id: recTaskId });
    const wf = res.data || {};
    check("workflow_save 固化 3 步（slug 化 + task_context 排除）",
      res.ok && wf.name === "smoke-macro" && wf.step_count === 3,
      jstr(res));
    res = await ctlCall(ctl, "daemon.workflow_list");
    const wfs = (res.data || {}).workflows || [];
    check("workflow_list 含 smoke-macro",
      res.ok && wfs.some((w) => w.name === "smoke-macro" && w.step_count === 3),
      jstr(wfs));
    // 8e. 无扩展重放：首败即停（默认），每步 ok=false 但整体结构完整
    res = await ctlCall(ctl, "daemon.workflow_run", { name: "smoke-macro" });
    let run = res.data || {};
    const step0 = (run.results || [{}])[0];
    check("workflow_run 无扩展首败即停",
      res.ok && run.ran === 1 && run.failed === 1
      && step0.ok === false
      && ["DISCONNECTED", "NO_EXTENSION"].includes(step0.code),
      jstr(res));
    res = await ctlCall(ctl, "daemon.workflow_run",
      { name: "smoke-macro", continue_on_error: true });
    run = res.data || {};
    check("workflow_run continue_on_error 跑完全部",
      res.ok && run.ran === 3 && run.failed === 3
      && (run.results || []).every((s) => !s.ok),
      jstr(res));
    res = await ctlCall(ctl, "daemon.workflow_run", { name: "no-such-wf" });
    check("workflow_run 不存在 NOT_FOUND",
      !res.ok && res.error && res.error.code === "NOT_FOUND"
      && res.error.retryable === false,
      jstr(res));
    // 8f. 会话库：无扩展 state_save 透传失败；state_list 空库
    res = await ctlCall(ctl, "daemon.state_save", { name: "zhihu" });
    check("state_save 无扩展透传失败",
      !res.ok && res.error
      && ["DISCONNECTED", "NO_EXTENSION"].includes(res.error.code),
      jstr(res));
    res = await ctlCall(ctl, "daemon.state_list");
    check("state_list 空库",
      res.ok && res.data && Array.isArray(res.data.states)
      && res.data.states.length === 0,
      jstr(res));
    res = await ctlCall(ctl, "daemon.state_load", { name: "ghost" });
    check("state_load 不存在 NOT_FOUND",
      !res.ok && res.error && res.error.code === "NOT_FOUND",
      jstr(res));

    // 8g. Batch 1 参数名/文档对齐
    // BUG-28/BUG-45: 描述里的 source 与实现里的 signer_code 都要认
    const SIGNER = "(input) => ({ sig: String(input.a) + '-' + String(input.b) })";
    res = await ctlCall(ctl, "daemon.verify_signer", {
      source: SIGNER,
      samples: [{ id: "s1", input: { a: 1, b: 2 }, expected: { sig: "1-2" } }],
    });
    check("BUG-28 verify_signer 收 source 别名",
      res.ok && res.data && res.data.pass_rate === 1, jstr(res));
    res = await ctlCall(ctl, "daemon.verify_signer", {
      signer_code: SIGNER,
      samples: [{ id: "s1", input: { a: 1, b: 2 }, expected: { sig: "1-2" } }],
    });
    check("BUG-28 verify_signer 仍收 signer_code",
      res.ok && res.data && res.data.pass_rate === 1, jstr(res));
    // UX-56: 全挂还 ok=true 是误导
    res = await ctlCall(ctl, "daemon.verify_signer", {
      source: SIGNER,
      samples: [{ id: "s1", input: { a: 1, b: 2 }, expected: { sig: "WRONG" } }],
    });
    check("UX-56 全部样本失败返回 VERIFY_FAILED",
      !res.ok && res.error && res.error.code === "VERIFY_FAILED", jstr(res));
    // UX-109: 只给 calls 走 dry_run —— 回算出的值，且不谎报 pass_rate
    res = await ctlCall(ctl, "daemon.verify_signer", {
      source: SIGNER, calls: [{ args: [{ a: 7, b: 8 }] }],
    });
    check("UX-109 calls 走 dry_run 并回算出的值",
      res.ok && res.data && res.data.mode === "dry_run"
      && res.data.pass_rate === undefined
      && ((res.data.results || [])[0] || {}).computed.sig === "7-8",
      jstr(res));
    res = await ctlCall(ctl, "daemon.verify_signer", { samples: [] });
    check("verify_signer 缺 source 报 BAD_ARGS",
      !res.ok && res.error && res.error.code === "BAD_ARGS", jstr(res));
    // UX-85: daemon 侧工具漏了前缀，错误里要直接给出正确名字
    res = await ctlCall(ctl, "state_list", {});
    check("UX-85 无前缀调 daemon 工具给出 daemon. 提示",
      !res.ok && res.error && res.error.code === "UNKNOWN_TOOL"
      && /daemon\.state_list/.test(res.error.message), jstr(res));
    // 两侧同名的 status/download 不改路由，仍旧转发扩展
    res = await ctlCall(ctl, "status", {});
    check("UX-85 同名工具 status 仍走扩展",
      !res.ok && res.error
      && ["NO_EXTENSION", "DISCONNECTED"].includes(res.error.code), jstr(res));
    // BUG-26/UX-57: 断言字段别名经 ctl 链路同样生效
    res = await ctlCall(ctl, "daemon.har_assert", {
      har: { log: { entries: [] } },
      assertions: [{ type: "min_requests", min: 0 }],
    });
    check("BUG-26 har_assert 收 min 别名",
      res.ok && res.data && res.data.passed === 1, jstr(res));

    // 8h. Batch 2/3
    // UX-173: 空断言集不能算"全过"
    res = await ctlCall(ctl, "daemon.har_assert", {
      har: { log: { entries: [] } }, assertions: [],
    });
    check("UX-173 空断言集报 BAD_ARGS",
      !res.ok && res.error && res.error.code === "BAD_ARGS", jstr(res));
    // UX-204: har 传 JSON 字符串原来静默当成空 HAR，断言全过
    res = await ctlCall(ctl, "daemon.har_assert", {
      har: jstr({ log: { entries: [
        { request: { method: "GET", url: "https://x.test/api/data" },
          response: { status: 200, content: { text: "{}" } } },
      ] } }),
      assertions: [{ type: "request_exists", url_pattern: "/api/data" }],
    });
    check("UX-204 har 传 JSON 字符串也能解析",
      res.ok && res.data && res.data.ok === true && res.data.passed === 1, jstr(res));
    res = await ctlCall(ctl, "daemon.har_assert", {
      har: "{not json", assertions: [{ type: "min_requests", count: 1 }],
    });
    check("UX-204 坏 JSON 报 BAD_HAR",
      !res.ok && res.error && res.error.code === "BAD_HAR", jstr(res));
    // data.ok 是判定位（外层 ok 只表示跑完了）
    res = await ctlCall(ctl, "daemon.har_assert", {
      har: { log: { entries: [] } },
      assertions: [{ type: "min_requests", count: 5 }],
    });
    check("har_assert 判定在 data.ok",
      res.ok && res.data.ok === false && res.data.failed === 1, jstr(res));
    // UX-172: 非法 format 不能静默回退 python
    res = await ctlCall(ctl, "daemon.har_to_replay", {
      har: { log: { entries: [] } }, format: "ruby",
    });
    check("UX-172 har_to_replay 非法 format 报 BAD_ARGS",
      !res.ok && res.error.code === "BAD_ARGS"
      && /python\|curl\|node/.test(res.error.message), jstr(res));
    // UX-186: 会话库删除
    res = await ctlCall(ctl, "daemon.state_delete", { name: "ghost" });
    check("UX-186 state_delete 不存在报 NOT_FOUND",
      !res.ok && res.error.code === "NOT_FOUND", jstr(res));
    res = await ctlCall(ctl, "daemon.state_delete", {});
    check("UX-186 state_delete 缺 name 报 BAD_ARGS",
      !res.ok && res.error.code === "BAD_ARGS", jstr(res));
    // UX-212: hook_logs 的 since 别名
    res = await ctlCall(ctl, "daemon.hook_logs", { since: 999999, limit: 5 });
    check("UX-212 hook_logs 收 since 别名",
      res.ok && res.data && res.data.count === 0, jstr(res));

    // UX-51: 一条慢调用不得堵死同一 ctl 连接上的后续调用。
    // 老实现是 Promise 链串行队列 —— wait_user（最长 280s）期间 AI 什么都干不了。
    const ext51 = new MockExtension(port);
    await ext51.connect();
    ext51.serve();
    await sleep(200);
    // 两条调用同时在飞，必须按 id 各收各的（共用 recvJson 会互相吞结果）
    const timings = {};
    const onResult = (data) => {
      let m;
      try { m = JSON.parse(data.toString()); } catch { return; }
      if (m.type === "result" && timings[m.id]) timings[m.id].done = Date.now();
    };
    ctl.on("message", onResult);
    const t0 = Date.now();
    timings.slow51 = { sent: t0 };
    timings.fast51 = { sent: t0 };
    ctl.send(jstr({ type: "call", id: "slow51", name: "status", args: { slow_ms: 1500 } }));
    await sleep(100);
    timings.fast51.sent = Date.now();
    ctl.send(jstr({ type: "call", id: "fast51", name: "status", args: {} }));
    await waitFor(() => timings.slow51.done && timings.fast51.done, 8000, 50);
    ctl.off("message", onResult);
    const fastMs = timings.fast51.done - timings.fast51.sent;
    const slowMs = timings.slow51.done - timings.slow51.sent;
    check("UX-51 慢调用不阻塞后续调用",
      fastMs >= 0 && fastMs < 800 && slowMs >= 1400,
      `fast=${fastMs}ms slow=${slowMs}ms`);
    ext51.stop();
    try { ext51.ws.close(); } catch {}

    ctl.close();
    ctl2.close();
  } finally {
    if (ctl3) { try { ctl3.close(); } catch {} }
    if (ctl2) { try { ctl2.close(); } catch {} }
    if (ctl) { try { ctl.close(); } catch {} }
    await killProc(daemon);
  }

  return summarize("[daemon 日志尾部]\n" + daemonLog.slice(-1000));
}

main().then((rc) => process.exit(rc)).catch((e) => {
  console.error("[FAIL] 测试异常:", e);
  process.exit(1);
});

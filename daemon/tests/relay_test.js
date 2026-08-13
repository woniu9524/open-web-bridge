/**
 * daemon 中转模式集成测试：mock 中转 + 真 daemon 子进程 + 充当扩展的控制器。
 *
 * 验证：
 *   1. daemon 启动时拨出到中转（OWB_RELAY_URL/TOKEN）
 *   2. 两端经 mock 中转配对 → relay_paired
 *   3. daemon 原子交接 handleExtension：扩展 hello → hello_ack（经中转透明往返）
 *   4. ctl call status → tool_call 经中转转发到扩展 → tool_result 回到 ctl
 *   5. status.data.mode === "relay"、relay_url 回填
 *
 * 运行：cd daemon && node tests/relay_test.js
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";
import { makeChecker, freePort, waitPort, killProc } from "./kit.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_DIR = path.resolve(__dirname, "..");

const { check, summarize } = makeChecker();
const jstr = (o) => JSON.stringify(o);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TOKEN = "relay-test-token-xyz";

let bootLog = "";

function recvJson(ws, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("recv timeout")); }, timeoutMs);
    function onMsg(data) {
      cleanup();
      try { resolve(JSON.parse(data.toString())); } catch (e) { reject(e); }
    }
    function onErr(e) { cleanup(); reject(e); }
    function cleanup() { clearTimeout(timer); ws.off("message", onMsg); ws.off("error", onErr); }
    ws.on("message", onMsg);
    ws.on("error", onErr);
  });
}

// mock 中转：单 pair（一个 ext 槽 + 一个 ctl 槽），对端已在线即配对，之后透明双向转发。
// 行为对齐 relay/src/relay-room.js 的 Durable Object（含重连重配对）。
function startMockRelay(port) {
  const wss = new WebSocketServer({ port, host: "127.0.0.1" });
  let ext = null, ctl = null;
  wss.on("connection", (ws, req) => {
    const url = new URL(req.url || "/", "http://x");
    const role = url.searchParams.get("role");
    ws.on("error", () => {});
    const other = role === "extension" ? ctl : ext; // 对端（连入前快照）
    if (role === "extension") ext = ws;
    else if (role === "controller") ctl = ws;
    if (other && other.readyState === WebSocket.OPEN) {
      try { ws.send(jstr({ type: "relay_paired", role })); } catch {}
      try { other.send(jstr({ type: "relay_paired", role: role === "extension" ? "controller" : "extension" })); } catch {}
    }
    ws.on("message", (data) => {
      const peer = ws === ext ? ctl : ext;
      if (peer && peer.readyState === WebSocket.OPEN) peer.send(data.toString());
    });
    ws.on("close", () => {
      if (ws === ext) ext = null;
      if (ws === ctl) ctl = null;
    });
  });
  return wss;
}

async function main() {
  const relayPort = await freePort();
  const daemonPort = await freePort();
  const relay = startMockRelay(relayPort);
  check("mock 中转启动", true, `port=${relayPort}`);

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-relay-test-"));

  const env = {
    ...process.env,
    OWB_PORT: String(daemonPort),
    OWB_WORK_DIR: workDir,
    OWB_RELAY_URL: `ws://127.0.0.1:${relayPort}`,
    OWB_RELAY_TOKEN: TOKEN,
  };
  const proc = spawn(process.execPath, ["src/server.js"], {
    cwd: DAEMON_DIR, env, stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => { bootLog += d.toString(); });
  proc.stderr.on("data", (d) => { bootLog += d.toString(); });

  try {
    check("daemon /ctl 端口就绪", await waitPort(daemonPort, 15), "");

    // 1. 扩展连中转（先挂 recvJson 监听器再等 open，防 relay_paired 早到丢帧）
    const ext = new WebSocket(`ws://127.0.0.1:${relayPort}/${TOKEN}?role=extension`);
    const pairedP = recvJson(ext, 15000);
    await new Promise((r) => ext.once("open", r));
    ext.on("error", () => {});

    // 2. 等 relay_paired（daemon 已作为 controller 拨入并配对）
    const paired = await pairedP;
    check("扩展收到 relay_paired", paired.type === "relay_paired", jstr(paired));

    // 3. 扩展发 hello → 经中转 → daemon handleExtension → hello_ack 回来
    ext.send(jstr({
      type: "hello",
      payload: { client: "open-web-bridge-extension", version: "0.0.0-relaytest" },
    }));
    const ack = await recvJson(ext, 10000);
    check("扩展收到 hello_ack（daemon 完成交接）", ack.type === "hello_ack", jstr(ack));

    // 4. ctl 通道调用 status
    const ctl = new WebSocket(`ws://127.0.0.1:${daemonPort}/ctl`);
    await new Promise((r) => ctl.once("open", r));
    ctl.on("error", () => {});
    ctl.send(jstr({ type: "call", id: "c1", name: "daemon.status", args: {}, timeout: 15 }));

    // 4a. 扩展侧应收到经中转转发的 tool_call（status 是扩展工具，会转发）
    //     —— 但 daemon.status 是本地工具，不转发扩展。改用一个扩展工具验证转发：
    //     直接验证 daemon.status 本地返回 mode=relay 即可（不走扩展）。
    const res = await recvJson(ctl, 10000);
    check("daemon.status 返回 mode=relay",
      res.ok && res.data && res.data.mode === "relay", jstr(res));
    check("relay_url 回填",
      res && res.data && res.data.relay_url === `ws://127.0.0.1:${relayPort}`, jstr(res));
    check("extension_connected=true（经中转接管）",
      res && res.data && res.data.extension_connected === true, jstr(res));

    // 5. 扩展工具转发：ctl call list_tabs → 经中转到扩展
    ctl.send(jstr({ type: "call", id: "c2", name: "list_tabs", args: {}, timeout: 15 }));
    const fwdCall = await recvJson(ext, 10000);
    check("扩展收到转发的 tool_call（list_tabs）",
      fwdCall.type === "tool_call" && fwdCall.payload && fwdCall.payload.name === "list_tabs",
      jstr(fwdCall));
    // 扩展回 tool_result
    ext.send(jstr({
      type: "tool_result",
      requestId: fwdCall.requestId,
      payload: { ok: true, data: { tabs: [], relayed: true } },
    }));
    const res2 = await recvJson(ctl, 10000);
    check("ctl 收到经中转回的 tool_result",
      res2.id === "c2" && res2.ok && res2.data && res2.data.relayed === true, jstr(res2));
  } finally {
    await killProc(proc);
    relay.close();
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
  if (bootLog.includes("中转模式")) {
    check("启动日志标注中转模式", true, "");
  } else {
    check("启动日志标注中转模式", false, bootLog.split("\n")[0]);
  }
  return summarize();
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error("relay_test fatal:", e);
  console.error("---- daemon boot log ----\n" + bootLog + "\n---- end ----");
  process.exit(1);
});

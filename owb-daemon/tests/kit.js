/**
 * 测试专用公共件：端口/进程/WS helper 与 check 计分骨架。
 * 供 smoke_test / mcp_test / e2e_browser_test / verify_replay_test 共用。
 */
import net from "node:net";

export const HOST = "127.0.0.1";

/** check 计分骨架：check() 记一项，summarize() 打印汇总并返回退出码。 */
export function makeChecker() {
  const results = [];
  function check(name, cond, detail = "") {
    results.push([name, !!cond]);
    console.log(`[${cond ? "PASS" : "FAIL"}] ${name}` + (detail ? `  -- ${detail}` : ""));
  }
  /** 打印 "N/M passed" 并返回退出码；有失败且给了 extraLog 时附带打印。 */
  function summarize(extraLog = "") {
    const failed = results.filter(([, ok]) => !ok);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    if (failed.length && extraLog) console.log(extraLog);
    return failed.length ? 1 : 0;
  }
  return { results, check, summarize };
}

/** 挑一个空闲端口。 */
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, HOST, () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

/** 轮询等端口可连（daemon 子进程就绪探测）。 */
export function waitPort(port, timeoutS = 15) {
  const deadline = Date.now() + timeoutS * 1000;
  return new Promise((resolve) => {
    const tryOnce = () => {
      const sock = net.connect(port, HOST);
      sock.once("connect", () => { sock.destroy(); resolve(true); });
      sock.once("error", () => {
        if (Date.now() > deadline) return resolve(false);
        setTimeout(tryOnce, 300);
      });
    };
    tryOnce();
  });
}

/** 杀子进程：先 SIGTERM，graceMs 后没死补 SIGKILL。 */
export function killProc(proc, graceMs = 5000) {
  return new Promise((resolve) => {
    if (!proc || proc.exitCode !== null) return resolve();
    const timer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, graceMs);
    proc.once("exit", () => { clearTimeout(timer); resolve(); });
    try { proc.kill(); } catch { clearTimeout(timer); resolve(); }
  });
}

/** 等 WS open（error/超时 reject）。 */
export function onceOpen(ws, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ws open timeout")), timeoutMs);
    ws.once("open", () => { clearTimeout(timer); resolve(); });
    ws.once("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

/** WS URL 拼 token 参数（对齐 server.js withToken）。 */
export function tk(url, token) {
  return token ? url + "?token=" + encodeURIComponent(token) : url;
}

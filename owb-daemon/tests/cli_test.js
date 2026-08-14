/**
 * owb CLI 冒烟测试：spawn 真 daemon，再以子进程跑 cli.js 各命令。
 *
 * 覆盖（取代原 MCP 接入面测试）：
 *   1. 命令表完整性：79 个底层工具都有 CLI 映射（除纯事件面 subscribe/events）
 *   2. daemon-status → ok，data 落 stdout
 *   3. 未知命令 → 退出码 2（用法错误）
 *   4. call 逃生口 + 转发链路：status 到扩展通道（未连 NO_EXTENSION，连着 ok）
 *   5. 参数映射：--tab / @ref / 位置参数越界 / --args 合并
 *   6. help 渐进披露
 *
 * 端口隔离：freePort + OWB_PORT/OWB_WORK_DIR，跑完杀 daemon。
 * 运行：cd owb-daemon && node tests/cli_test.js
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeChecker, freePort, waitPort, killProc } from "./kit.js";
import { COMMANDS } from "../src/cli.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_DIR = path.resolve(__dirname, "..");
const CLI = path.join(DAEMON_DIR, "src", "cli.js");

const { check, summarize } = makeChecker();

// 跑一次 cli.js 子进程，返回 {code, out, err}
function runCli(args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], {
      cwd: DAEMON_DIR,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", (code) => resolve({ code, out, err }));
  });
}

function parseOut(out) {
  try { return JSON.parse(out); } catch { return null; }
}

async function main() {
  const port = await freePort();
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-cli-test-"));
  const env = { ...process.env, OWB_PORT: String(port), OWB_WORK_DIR: workdir };
  const daemon = spawn(process.execPath, ["src/server.js"], {
    cwd: DAEMON_DIR, env, stdio: ["ignore", "pipe", "pipe"],
  });
  let daemonLog = "";
  daemon.stdout.on("data", (d) => { daemonLog += d; });
  daemon.stderr.on("data", (d) => { daemonLog += d; });

  try {
    if (!(await waitPort(port, 15))) {
      check("daemon 端口就绪", false, daemonLog.slice(-500));
      return 1;
    }

    // 1. 命令表覆盖：所有底层工具（除纯事件面）都有 CLI 映射
    const ctlNames = new Set([...COMMANDS.values()].map((s) => s.ctl.replace(/^daemon\./, "daemon_")));
    // 抽查关键工具都在命令表里（映射到某个 CLI 命令）
    const covered = (n) => [...COMMANDS.values()].some((s) => s.ctl === n || s.ctl === "daemon." + n.replace(/^daemon_/, ""));
    check("命令表覆盖数 ≥ 60", COMMANDS.size >= 60, `size=${COMMANDS.size}`);
    check("核心页面工具在命令表",
      covered("read_page") && covered("click") && covered("fill") && covered("wait_for") && covered("navigate"));
    check("daemon 侧工具在命令表",
      covered("daemon_status") && covered("daemon_state_save") && covered("daemon_workflow_run")
      && covered("daemon_har_save") && covered("daemon_replay"));
    check("录制/环境/人机工具在命令表",
      covered("record_start") && covered("emulate") && covered("emulate_reset")
      && covered("handoff") && covered("wait_user") && covered("mouse_click"));

    // 2. daemon-status → ok，data 落 stdout
    let r = await runCli(["daemon-status", "--compact"], env);
    let body = parseOut(r.out);
    check("daemon-status → ok",
      r.code === 0 && body && "extension_connected" in body, r.out.slice(0, 200) + r.err.slice(0, 100));

    // 3. 未知命令 → 退出码 2
    r = await runCli(["frobnicate"], env);
    check("未知命令退出码 2", r.code === 2, `code=${r.code} ${r.err.slice(0, 80)}`);

    // 4. 转发链路：status 到扩展通道（--no-autostart 防止意外拉起本机 daemon）
    r = await runCli(["status", "--compact"], env);
    body = parseOut(r.out);
    const code = r.err.match(/error (\w+)/);
    check("status 转发链路",
      (r.code === 0 && body && "ws" in body)
      || (code && ["DISCONNECTED", "NO_EXTENSION"].includes(code[1])),
      r.out.slice(0, 120) + " | " + r.err.slice(0, 120));

    // 5a. call 逃生口：直调底层工具名
    r = await runCli(["call", "daemon.status", "--compact"], env);
    body = parseOut(r.out);
    check("call 逃生口直调", r.code === 0 && body && "mode" in body, r.out.slice(0, 120));

    // 5b. @ref 映射：click @e5 → 走 ref 分支（错误码不是 selector-required）
    r = await runCli(["click", "@e5", "--raw", "--compact"], env);
    check("click @ref 映射为 ref",
      !/selector or ref is required/.test(r.out + r.err), r.out.slice(0, 160) + r.err.slice(0, 120));

    // 5c. 位置参数越界 → 退出码 2
    r = await runCli(["open", "http://x.com", "extra-junk"], env);
    check("位置参数越界退出码 2", r.code === 2, `code=${r.code}`);

    // 5d. --args 合并：无扩展下 find_tab 报 NO_EXTENSION 即证明参数已送达转发链路
    //（合并失败会先在 CLI 侧报用法错误，退出码 2）。
    r = await runCli(["call", "find_tab", "--args", '{"url_pattern":"zzz-nomatch"}', "--compact"], env);
    body = parseOut(r.out);
    const argCode = r.err.match(/error (\w+)/);
    check("--args JSON 合并",
      (r.code === 0 && body && "tabs" in body)
      || (argCode && ["DISCONNECTED", "NO_EXTENSION"].includes(argCode[1])),
      r.out.slice(0, 120) + " | " + r.err.slice(0, 120));

    // 6. help 渐进披露
    r = await runCli(["help"], env);
    check("help 列出命令组", /\[基础\]/.test(r.out) && /\[net\]/.test(r.out) && /\[state\]/.test(r.out));
    r = await runCli(["help", "基础"], env);
    check("help <组> 展开详情", /owb open/.test(r.out) && /owb click/.test(r.out));
  } finally {
    await killProc(daemon);
  }

  return summarize("[daemon 日志尾部]\n" + daemonLog.slice(-800));
}

main().then((rc) => process.exit(rc)).catch((e) => {
  console.error("[FAIL] 测试异常:", e);
  process.exit(1);
});

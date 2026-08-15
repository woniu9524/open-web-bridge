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
import { COMMANDS, parseArgv, tokenizeStep, resolveInvocation } from "../src/cli.js";

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
      && covered("handoff") && covered("wait_user"));
    // mouse_click 走 click --mouse 开关，不再占命令表一行
    check("click --mouse 切到 mouse_click 工具",
      resolveInvocation(["click", "@e5"], { mouse: true },
        { timeout: 120, rawArgs: null }).ctlName === "mouse_click");

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
    check("help 列出命令组", /\[core\]/.test(r.out) && /\[net\]/.test(r.out) && /\[state\]/.test(r.out));
    r = await runCli(["help", "core"], env);
    check("help <组> 展开详情", /owb open/.test(r.out) && /owb click/.test(r.out));

    // 6b. BUG-115: 语义上是字符串的参数不能被自动 JSON 解析。
    // CDP 的 requestId 长得像小数（"110404.81"），被转成数字后 Map 查找必然
    // 落空 —— `net list` → `net detail` 这条下钻路径对每一条请求都 NOT_FOUND。
    const pv = (argv) => parseArgv(argv).args;
    check("BUG-115 request_id 保持字符串",
      pv(["net", "detail", "--request-id", "110404.81"]).request_id === "110404.81");
    check("BUG-115 script_id 纯数字串也不转数字",
      pv(["script", "source", "--script-id", "12345"]).script_id === "12345");
    check("BUG-115 --text 404 不变成数字",
      pv(["wait", "--text", "404"]).text === "404");
    check("BUG-115 --url-pattern 数字串保持正则文本",
      pv(["net", "list", "--url-pattern", "2024"]).url_pattern === "2024");
    // 真正该被解析的仍要解析，别把这层管过头
    check("BUG-115 布尔/数字参数仍按原样解析",
      pv(["open", "--new-tab", "true"]).new_tab === true
      && pv(["page", "--max-nodes", "1200"]).max_nodes === 1200
      && pv(["page", "--tab", "612684020"]).tabId === 612684020);

    // 6c. BUG-120: help 的组摘要行必须是「能照着敲」的真实命令形态。
    // 原来一律只取最后一段，于是 `debug break-xhr`（要前缀）和 `oracle`
    // （顶层）长得一样；file 组正好相反。照着敲 `owb debug oracle` /
    // `owb file download` / `owb fetch` 全报未知命令。
    r = await runCli(["help"], env);
    const groupLines = r.out.split(/\r?\n/).filter((l) => /^\s*\[/.test(l));
    const unrunnable = [];
    for (const line of groupLines) {
      const m = line.match(/^\s*\[([^\]]+)\]\s*(.*)$/);
      if (!m) continue;
      const [, gname, rest] = m;
      const shown = rest.includes(" / ") ? rest.split(" / ") : rest.trim().split(/\s+/);
      for (const name of shown.map((x) => x.trim()).filter(Boolean)) {
        // 照着这行敲：要么它本身是命令，要么补上组名前缀是命令
        if (!COMMANDS.has(name) && !COMMANDS.has(`${gname} ${name}`)) {
          unrunnable.push(`[${gname}] ${name}`);
        }
      }
    }
    check("BUG-120 help 里列出的每条命令都能照着敲",
      unrunnable.length === 0, unrunnable.join(", "));
    // 具体守住两个混用组
    check("BUG-120 debug 组把顶层的 oracle 与带前缀的区分开",
      /debug break-xhr/.test(r.out) && /(^| )oracle( |$)/m.test(r.out));
    check("BUG-120 file 组标出只有 fetch 带前缀", /file fetch/.test(r.out));

    // 7. BUG-110：经符号链接调用（npm link / pnpm / 全局 bin）入口守卫仍要成立。
    // Node 把 import.meta.url 解析到 realpath，argv[1] 却保留软链路径；旧守卫
    // 直接比这两者，于是 main() 静默不跑——无输出、无报错、退出码 0。
    const linkDir = path.join(workdir, "linked-src");
    let linked = false;
    try {
      fs.symlinkSync(path.join(DAEMON_DIR, "src"), linkDir,
        process.platform === "win32" ? "junction" : "dir");
      linked = true;
    } catch (e) {
      console.log(`[SKIP] BUG-110 软链入口守卫（无法创建符号链接：${e.code || e.message}）`);
    }
    if (linked) {
      const p = spawn(process.execPath, [path.join(linkDir, "cli.js"), "help"], {
        cwd: DAEMON_DIR, env, stdio: ["ignore", "pipe", "pipe"],
      });
      let lout = "", lerr = "";
      p.stdout.on("data", (d) => { lout += d; });
      p.stderr.on("data", (d) => { lerr += d; });
      const lcode = await new Promise((res) => p.on("close", res));
      check("BUG-110 经符号链接调用 CLI 仍执行 main()",
        lcode === 0 && /\[core\]/.test(lout),
        `code=${lcode} out=${lout.slice(0, 80) || "(空)"} err=${lerr.slice(0, 80)}`);
    }

    // 8. seq：一条连接连跑多步，一步一行 JSONL + 汇总行
    r = await runCli(["seq", "daemon-status", "call daemon.status --compact"], env);
    let seqLines = r.out.trim().split(/\r?\n/).map(parseOut);
    check("seq 两步全成 + 汇总行",
      r.code === 0 && seqLines.length === 3
      && seqLines[0] && seqLines[0].step === 1 && seqLines[0].ok === true
      && seqLines[1] && seqLines[1].ok === true && "mode" in (seqLines[1].data || {})
      && seqLines[2] && seqLines[2].seq
      && seqLines[2].seq.ok === 2 && seqLines[2].seq.failed === 0,
      r.out.slice(0, 300) + r.err.slice(0, 100));

    // 8b. 失败即停：坏步 → USAGE，后续跳过，退出码 1
    r = await runCli(["seq", "frobnicate", "daemon-status"], env);
    seqLines = r.out.trim().split(/\r?\n/).map(parseOut);
    check("seq 失败即停 + skipped 计数",
      r.code === 1 && seqLines.length === 2
      && seqLines[0] && seqLines[0].ok === false
      && seqLines[0].error && seqLines[0].error.code === "USAGE"
      && seqLines[1] && seqLines[1].seq
      && seqLines[1].seq.stoppedAt === 1 && seqLines[1].seq.skipped === 1,
      r.out.slice(0, 300));

    // 8c. --keep-going：坏步不拦后面的好步，但退出码仍标失败
    r = await runCli(["seq", "--keep-going", "frobnicate", "daemon-status"], env);
    seqLines = r.out.trim().split(/\r?\n/).map(parseOut);
    check("seq --keep-going 继续执行",
      r.code === 1 && seqLines.length === 3
      && seqLines[1] && seqLines[1].ok === true
      && seqLines[2] && seqLines[2].seq
      && seqLines[2].seq.ok === 1 && seqLines[2].seq.failed === 1,
      r.out.slice(0, 300));

    // 8d. 步骤切词：引号保 @ref / 含空格值整体；反斜杠不转义（Windows 路径）；
    // 未闭合引号报用法错误
    check("seq 切词保引号整体",
      JSON.stringify(tokenizeStep(`fill '@e3' "hello world"`))
        === JSON.stringify(["fill", "@e3", "hello world"]));
    check("seq 切词不吃 Windows 反斜杠路径",
      JSON.stringify(tokenizeStep("file fetch --url C:\\Users\\a"))
        === JSON.stringify(["file", "fetch", "--url", "C:\\Users\\a"]));
    check("seq 未闭合引号 → 用法错误", (() => {
      try { tokenizeStep("fill '@e3"); return false; } catch (e) { return true; }
    })());

    // 9. 命令表修剪：砍/改过的名字必须给指路错误（退出码 2），新名必须在表里
    check("har discard / debug stack 在命令表，旧名不在",
      COMMANDS.has("har discard") && COMMANDS.get("har discard").ctl === "record_stop"
      && COMMANDS.has("debug stack") && COMMANDS.get("debug stack").ctl === "frame_read"
      && !COMMANDS.has("har stop") && !COMMANDS.has("debug frames")
      && !COMMANDS.has("click-mouse") && !COMMANDS.has("state export"));
    r = await runCli(["click-mouse", "@e5"], env);
    check("click-mouse 指路 click --mouse", r.code === 2 && /click.*--mouse/.test(r.err),
      `code=${r.code} ${r.err.slice(0, 120)}`);
    r = await runCli(["har", "stop"], env);
    check("har stop 指路 har discard / har save", r.code === 2 && /har discard/.test(r.err),
      `code=${r.code} ${r.err.slice(0, 120)}`);
    r = await runCli(["debug", "frames"], env);
    check("debug frames 指路 debug stack", r.code === 2 && /debug stack/.test(r.err),
      `code=${r.code} ${r.err.slice(0, 120)}`);
    r = await runCli(["state", "export"], env);
    check("state export 指路 call export_state", r.code === 2 && /export_state/.test(r.err),
      `code=${r.code} ${r.err.slice(0, 120)}`);
  } finally {
    await killProc(daemon);
  }

  return summarize("[daemon 日志尾部]\n" + daemonLog.slice(-800));
}

main().then((rc) => process.exit(rc)).catch((e) => {
  console.error("[FAIL] 测试异常:", e);
  process.exit(1);
});

/**
 * 文档示例**执行**测试：挑一批无副作用的示例，对着一个隔离的 daemon 真跑一遍，
 * 断言它们**不因用法问题而失败**。
 *
 * 补的是 docs_examples_test.js 查不到的那一层。BUG-119 就是典型：
 *   owb flow save 周报   → BAD_ARGS: workflow_save: name is required
 * 命令名完全正确（静态 lint 全绿），坏在参数处理——纯中文名被 slug 抹成空串。
 * 这类"命令对、参数被吃掉"的问题只有真跑才看得见。
 *
 * 判据不是"必须成功"——多数命令需要浏览器，返回 NO_EXTENSION 很正常。
 * 判据是**不能是用法类错误**：
 *   ✗ 退出码 2（CLI 用法错误）／ BAD_ARGS ／ 未知命令
 *   ✓ NO_EXTENSION ／ NEED_TASK ／ NOT_FOUND ／ 正常成功
 * 也就是说：参数被正确接收并送达了，剩下的是环境问题。
 *
 * 端口与 work 目录隔离，跑完杀 daemon，不碰用户的浏览器与真实 work/。
 * 运行：node owb-daemon/tests/docs_run_test.js
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeChecker, freePort, waitPort, killProc } from "./kit.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_DIR = path.resolve(__dirname, "..");
const CLI = path.join(DAEMON_DIR, "src", "cli.js");

const { check, summarize } = makeChecker();

// 文档里出现过、且**不会碰用户浏览器 / 不产生外部副作用**的示例。
// 中文名的几条是重点：BUG-119 就是被它们抓出来的。
const CASES = [
  // 任务与流程（daemon 侧，SKILL.md「固化流程」一节）
  ['task begin "竞品定价调研"', "中文任务名"],
  ["flow save 周报", "中文流程名（BUG-119）"],
  ["flow list", "列流程"],
  ["task list", "列任务"],
  ["task end", "结束任务"],
  // 登录态（SKILL.md「保存登录态」，用文档里的中文示例名）
  ["state list", "列登录态"],
  ["state load 某站", "中文登录态名（BUG-119 同源）"],
  ["state delete 某站", "中文名删除"],
  // 只读状态
  ["daemon-status", "看模式"],
  ["status", "扩展状态（无扩展应报 NO_EXTENSION，不是用法错误）"],
  // 需要浏览器的典型调用：参数必须能送达，返回 NO_EXTENSION 才算对
  ['open https://example.com --new-tab true', "开页面"],
  ["page --mode article", "读正文"],
  ["page --since-last true", "增量快照"],
  ["page --max-nodes 1200 --max-chars 60000", "调大上限"],
  ['wait --text "结果"', "等文字"],
  ["wait --network-idle true", "等网络空闲"],
  ["keys --keys Enter", "回车"],
  ['keys --text "逐字输入的文本"', "insertText"],
  ["net list --sort-by duration --limit 10", "最慢的十个"],
  ["net list --sort-by size --limit 10", "最重的十个"],
  ["tab list", "列标签页"],
  ["frames", "列 iframe"],
  ["env reset", "恢复模拟"],
];

// 用法类失败（说明参数没被正确接收）——这才是要拦的
function usageFailure(r) {
  if (r.code === 2) return "退出码 2（CLI 用法错误）";
  const m = (r.err || "").match(/error (BAD_ARGS|UNKNOWN_TOOL)\b/);
  if (m) return r.err.trim().slice(0, 150);
  if (/未知命令/.test(r.err || "")) return r.err.trim().slice(0, 120);
  return null;
}

function runCli(args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], {
      cwd: DAEMON_DIR, env, stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", (code) => resolve({ code, out, err }));
  });
}

// 引号内当作一个 token，别把 "竞品定价调研" 切开
const tokenize = (s) =>
  (s.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((t) => t.replace(/^['"]|['"]$/g, ""));

async function main() {
  const port = await freePort();
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-docsrun-"));
  // 明知这个隔离 daemon 没有扩展，跳过 35 秒退避（否则 13 条浏览器命令要跑 8 分钟）
  const env = { ...process.env, OWB_PORT: String(port), OWB_WORK_DIR: workdir,
    OWB_NO_EXT_RETRY: "1" };
  const daemon = spawn(process.execPath, ["src/server.js"], {
    cwd: DAEMON_DIR, env, stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  daemon.stdout.on("data", (d) => { log += d; });
  daemon.stderr.on("data", (d) => { log += d; });

  try {
    if (!(await waitPort(port, 15))) {
      check("daemon 端口就绪", false, log.slice(-400));
      return 1;
    }
    for (const [cmd, label] of CASES) {
      const r = await runCli([...tokenize(cmd), "--no-autostart", "--compact"], env);
      const bad = usageFailure(r);
      check(`owb ${cmd}  · ${label}`, bad === null, bad || "");
    }
  } finally {
    await killProc(daemon);
    fs.rmSync(workdir, { recursive: true, force: true });
  }
  return summarize("[daemon 日志尾部]\n" + log.slice(-600));
}

main().then((rc) => process.exit(rc)).catch((e) => {
  console.error("[FAIL] 测试异常:", e);
  process.exit(1);
});

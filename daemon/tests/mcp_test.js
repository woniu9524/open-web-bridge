/**
 * MCP 接入面冒烟测试：stdio 拉起真 mcp_server + 真 daemon 子进程。
 *
 * 覆盖：
 *   1. initialize + list_tools：69 个工具，daemon_* 命名映射在列
 *   2. call daemon_status → ok（daemon 本地工具不经浏览器，无需扩展）
 *   3. call 未知工具 → UNKNOWN_TOOL 错误模型
 *   4. call status → 转发到扩展通道（扩展未连时 NO_EXTENSION，连着时 ok；两者都算链路通）
 *
 * 自我端口隔离：挑空闲端口 spawn `node src/server.js`
 * （OWB_PORT + OWB_WORK_DIR=临时目录），mcp_server 经 StdioClientTransport 拉起，
 * 跑完全部杀掉。
 *
 * 运行：cd daemon && node tests/mcp_test.js
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { makeChecker, freePort, waitPort, killProc } from "./kit.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_DIR = path.resolve(__dirname, "..");

const { check, summarize } = makeChecker();

// callTool 结果 → (isError, body)：content[0].text 是 JSON 文本
function unwrap(res) {
  const text = res.content && res.content.length ? res.content[0].text : "";
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
  return [!!res.isError, body, text];
}

async function main() {
  const port = await freePort();
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-mcp-test-"));
  const daemon = spawn(process.execPath, ["src/server.js"], {
    cwd: DAEMON_DIR,
    env: { ...process.env, OWB_PORT: String(port), OWB_WORK_DIR: workdir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let daemonLog = "";
  daemon.stdout.on("data", (d) => { daemonLog += d; });
  daemon.stderr.on("data", (d) => { daemonLog += d; });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/mcp_server.js"],
    cwd: DAEMON_DIR,
    env: { ...process.env, OWB_PORT: String(port), OWB_WORK_DIR: workdir },
  });
  const client = new Client({ name: "owb-mcp-test", version: "0.0.0" }, { capabilities: {} });

  try {
    if (!(await waitPort(port, 15))) {
      check("daemon 端口就绪", false, daemonLog.slice(-500));
      return 1;
    }
    await client.connect(transport);

    const tools = (await client.listTools()).tools;
    const names = new Set(tools.map((t) => t.name));
    check("list_tools 69 个", tools.length === 69, `count=${tools.length}`);
    check("daemon_* 命名映射",
      names.has("daemon_status") && names.has("daemon_replay")
      && names.has("status") && names.has("oracle_call"));
    check("页面交互与 task 工具在列",
      names.has("wait_for") && names.has("read_page")
      && names.has("daemon_task_begin") && names.has("daemon_task_end")
      && names.has("daemon_task_list"));
    check("录制与 HAR 工具在列",
      names.has("record_start") && names.has("record_stop")
      && names.has("record_status") && names.has("daemon_har_save")
      && names.has("daemon_har_to_replay") && names.has("daemon_har_diff")
      && names.has("daemon_har_assert"));
    check("人机协作与工作流/会话库工具在列",
      names.has("mouse_click") && names.has("handoff") && names.has("wait_user")
      && names.has("daemon_workflow_save") && names.has("daemon_workflow_run")
      && names.has("daemon_workflow_list") && names.has("daemon_state_save")
      && names.has("daemon_state_load") && names.has("daemon_state_list"));
    check("task_context 不进 MCP", !names.has("task_context"));

    let res = await client.callTool({ name: "daemon_status", arguments: {} });
    // ok 路径直接返回 data（isError 表达成败，不再包 {"ok","data"} 外壳）
    let [isErr, body, text] = unwrap(res);
    check("call daemon_status",
      !isErr && "extension_connected" in body,
      text.slice(0, 200));

    res = await client.callTool({ name: "no_such_tool", arguments: {} });
    [isErr, body, text] = unwrap(res);
    check("未知工具错误模型",
      isErr && body.ok === false && (body.error || {}).code === "UNKNOWN_TOOL",
      text.slice(0, 200));

    // 转发链路：扩展连着 → isError=false 且 data 含 ws；没连 → NO_EXTENSION。
    res = await client.callTool({ name: "status", arguments: {} });
    [isErr, body, text] = unwrap(res);
    const code = (body.error || {}).code || "";
    check("call status 转发链路",
      (!isErr && "ws" in body) || ["DISCONNECTED", "NO_EXTENSION"].includes(code),
      text.slice(0, 200));
  } finally {
    try { await client.close(); } catch {}
    await killProc(daemon);
  }

  return summarize("[daemon 日志尾部]\n" + daemonLog.slice(-1000));
}

main().then((rc) => process.exit(rc)).catch((e) => {
  console.error("[FAIL] 测试异常:", e);
  process.exit(1);
});

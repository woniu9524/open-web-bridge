#!/usr/bin/env node
/**
 * 命令行控制器（测试用）：
 *
 *   owb-ctl status
 *   owb-ctl network_list '{"url_pattern": "api", "limit": 10}'
 *   owb-ctl network_detail '{"request_id": "..."}' --timeout 60
 *   owb-ctl --events [--since N] [--sources hook:xhr,network] [--url-pattern REGEX]
 *
 * ctl 通道直连（本地信任模型，无 token）。
 */
import WebSocket from "ws";
import { isMainModule } from "./ismain.js";
import { PORT } from "./server.js";

const DOC = `命令行控制器（测试用）：

  owb-ctl status
  owb-ctl network_list '{"url_pattern": "api", "limit": 10}'
  owb-ctl network_detail '{"request_id": "..."}' --timeout 60
  owb-ctl --events [--since N] [--sources hook:xhr,network] [--url-pattern REGEX]

ctl 通道直连（本地信任模型，无 token）。`;

function connect() {
  return new Promise((resolve, reject) => {
    const url = `ws://127.0.0.1:${PORT}/ctl`;
    const ws = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 });
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

async function call(name, args, timeout = 30.0) {
  const ws = await connect();
  return new Promise((resolve) => {
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === "result" && msg.id === "c1") {
        console.log(JSON.stringify(msg, null, 2));
        ws.close();
        resolve(msg.ok ? 0 : 1);
      }
    });
    ws.send(JSON.stringify({ type: "call", id: "c1",
                             name, args, timeout }));
  });
}

async function tailEvents(since, sources = null, urlPattern = null) {
  const ws = await connect();
  const sub = { type: "subscribe" };
  if (sources) sub.sources = sources;
  if (urlPattern) sub.url_pattern = urlPattern;
  ws.send(JSON.stringify(sub));
  ws.send(JSON.stringify({ type: "events", since_seq: since }));
  ws.on("message", (data) => console.log(data.toString()));
  return new Promise(() => {}); // 持续尾随，Ctrl-C 退出
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length) {
    console.log(DOC);
    return 2;
  }
  let timeout = 30.0;
  if (argv.includes("--timeout")) {
    const i = argv.indexOf("--timeout");
    timeout = parseFloat(argv[i + 1]);
    argv.splice(i, 2);
  }
  if (argv[0] === "--events") {
    let since = 0;
    let sources = null;
    let urlPattern = null;
    if (argv.includes("--since")) {
      since = parseInt(argv[argv.indexOf("--since") + 1], 10);
    }
    if (argv.includes("--sources")) {
      sources = argv[argv.indexOf("--sources") + 1].split(",");
    }
    if (argv.includes("--url-pattern")) {
      urlPattern = argv[argv.indexOf("--url-pattern") + 1];
    }
    return tailEvents(since, sources, urlPattern);
  }
  const name = argv[0];
  const args = argv.length > 1 ? JSON.parse(argv[1]) : {};
  return call(name, args, timeout);
}

// 仅作为主模块直接运行时才执行（供 import 时不触发 CLI）
if (isMainModule(import.meta.url)) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((e) => {
      console.error(String(e && e.message ? e.message : e));
      process.exitCode = 1;
    });
}

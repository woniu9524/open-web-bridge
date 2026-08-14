/**
 * hooks/xhr.js 预设的 Node 单测（无浏览器）。
 * 用最小 FakeXHR 验证：open/setRequestHeader/send 捕获、loadend 响应捕获、
 * toString 原生样式、重复注入幂等。
 *
 * 运行：node owb-daemon/tests/hook_xhr_test.js
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PRESET_PATH = path.join(__dirname, "..", "..", "owb-extension", "hooks", "xhr.js");
const source = fs.readFileSync(PRESET_PATH, "utf8");

// ---- 页面环境 mock ----
const reports = [];
global.window = {};
global.location = { href: "https://test.local/page" };
global.__owbReport = (s) => reports.push(JSON.parse(s));

class FakeXHR {
  constructor() {
    this._listeners = {};
    this.status = 0;
    this.responseText = "";
    this.responseType = "";
    this.responseURL = "";
  }
  open() {}
  setRequestHeader() {}
  send() {}
  addEventListener(type, fn) {
    (this._listeners[type] = this._listeners[type] || []).push(fn);
  }
  fire(type) {
    for (const fn of this._listeners[type] || []) fn.call(this);
  }
}
global.XMLHttpRequest = FakeXHR;

// ---- 注入预设（两次，验证幂等）----
eval(source);
eval(source);

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`[PASS] ${name}`); }
  else { failed++; console.log(`[FAIL] ${name}  -- ${detail}`); }
}

// ---- 场景：一次完整 POST ----
const xhr = new XMLHttpRequest();
xhr.open("POST", "https://api.test.local/v1/sign?x=1");
xhr.setRequestHeader("X-Token", "abc123");
xhr.setRequestHeader("Content-Type", "application/json");
xhr.send(JSON.stringify({ a: 1 }));
xhr.status = 200;
xhr.responseURL = "https://api.test.local/v1/sign?x=1";
xhr.responseText = '{"ok":true}';
xhr.fire("loadend");

const req = reports.find((r) => r.phase === "request");
const resp = reports.find((r) => r.phase === "response");

check("request 捕获 method/url", !!req && req.method === "POST" && req.url.includes("/v1/sign"),
  JSON.stringify(req));
check("request 捕获 headers", !!req && req.headers["X-Token"] === "abc123",
  JSON.stringify(req && req.headers));
check("request 捕获 body", !!req && req.body === '{"a":1}', req && req.body);
check("request 带 stack", !!req && typeof req.stack === "string" && req.stack.length > 0);
check("response 捕获 status/body", !!resp && resp.status === 200 && resp.body === '{"ok":true}',
  JSON.stringify(resp));
check("request/response id 一致", !!req && !!resp && req.id === resp.id);
check("payload 带 preset/href", !!req && req.preset === "xhr" && req.href === "https://test.local/page");

// ---- toString 原生样式 ----
check("open toString 原生样式",
  XMLHttpRequest.prototype.open.toString() === "function open() { [native code] }",
  XMLHttpRequest.prototype.open.toString());
check("send toString 原生样式",
  XMLHttpRequest.prototype.send.toString() === "function send() { [native code] }");
check("toString 自身原生样式",
  Function.prototype.toString.toString() === "function toString() { [native code] }");
check("未 hook 函数 toString 不受影响",
  FakeXHR.prototype.addEventListener.toString().includes("_listeners"));

// ---- 幂等：两次 eval 后仍只有一组报告 ----
const reqCount = reports.filter((r) => r.phase === "request").length;
check("重复注入幂等", reqCount === 1, `request reports=${reqCount}`);

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);

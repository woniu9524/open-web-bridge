/**
 * hooks/fn_hook.js 模板的 Node 单测（无浏览器）。
 * 模拟扩展的 OPTS 替换流程，覆盖：after/before/replace 三种 position、
 * hookCode 自定义代码、nonOverridable、toString 原生样式、错误路径、幂等。
 *
 * 运行：node daemon/tests/hook_fn_test.js
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TEMPLATE_PATH = path.join(__dirname, "..", "..", "extension", "hooks", "fn_hook.js");
const template = fs.readFileSync(TEMPLATE_PATH, "utf8");
const SENTINEL = "/*__OWB_OPTS__*/null/*__OWB_OPTS_END__*/";

if (!template.includes(SENTINEL)) {
  console.error("[FAIL] 模板缺少 OPTS 占位符");
  process.exit(1);
}

function buildSource(opts) {
  return template.replace(SENTINEL, JSON.stringify(opts));
}

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`[PASS] ${name}`); }
  else { failed++; console.log(`[FAIL] ${name}  -- ${detail}`); }
}

function freshEnv() {
  const reports = [];
  global.window = {};
  global.location = { href: "https://test.local/page" };
  global.__owbReport = (s) => reports.push(JSON.parse(s));
  return reports;
}

// ---- after + trace args/ret ----
let reports = freshEnv();
global.window.MyNS = { sign: function sign(x) { return "sig:" + x; } };
eval(buildSource({
  key: "fn:MyNS.sign#after", path: "MyNS.sign", position: "after",
  hookCode: null, replacement: null,
  trace: { args: true, ret: true, stack: false }, nonOverridable: false,
}));
const r1 = global.window.MyNS.sign("abc");
check("after: 原函数结果不变", r1 === "sig:abc", r1);
const installed = reports.find((r) => r.phase === "installed");
const retRep = reports.find((r) => r.phase === "return");
check("after: installed 报告", !!installed && installed.path === "MyNS.sign");
check("after: args 捕获", !!retRep && retRep.args[0] === "abc", JSON.stringify(retRep));
check("after: returnValue 捕获", !!retRep && retRep.returnValue === "sig:abc",
  retRep && retRep.returnValue);
check("after: toString 原生样式",
  global.window.MyNS.sign.toString() === "function sign() { [native code] }",
  global.window.MyNS.sign.toString());

// ---- before + hookCode ----
reports = freshEnv();
global.window.MyNS = { compute: function compute(n) { return n * 2; } };
global.window.__hookSeen = 0;
eval(buildSource({
  key: "fn:MyNS.compute#before", path: "MyNS.compute", position: "before",
  hookCode: "window.__hookSeen = (window.__hookSeen||0) + 1;",
  replacement: null,
  trace: { args: true, ret: false, stack: false }, nonOverridable: false,
}));
const r2 = global.window.MyNS.compute(21);
check("before: 原函数结果不变", r2 === 42, String(r2));
check("before: hookCode 执行", global.window.__hookSeen === 1,
  String(global.window.__hookSeen));
check("before: call 报告", reports.some((r) => r.phase === "call" && r.args[0] === "21"));

// ---- replace ----
reports = freshEnv();
global.window.target = { run: function run() { global.window.__origCalled = true; return "orig"; } };
eval(buildSource({
  key: "fn:target.run#replace", path: "target.run", position: "replace",
  hookCode: null, replacement: "function () { return 'REPLACED'; }",
  trace: { args: false, ret: false, stack: false }, nonOverridable: false,
}));
const r3 = global.window.target.run();
check("replace: 替换生效", r3 === "REPLACED", r3);
check("replace: 原函数未执行", !global.window.__origCalled);

// ---- nonOverridable ----
reports = freshEnv();
global.window.sdk = { token: function token() { return "t"; } };
eval(buildSource({
  key: "fn:sdk.token#after", path: "sdk.token", position: "after",
  hookCode: null, replacement: null,
  trace: { args: false, ret: false, stack: false }, nonOverridable: true,
}));
const desc = Object.getOwnPropertyDescriptor(global.window.sdk, "token");
check("nonOverridable: writable/configurable 为 false",
  desc && desc.writable === false && desc.configurable === false,
  JSON.stringify(desc));

// ---- 错误路径：目标不是函数 ----
reports = freshEnv();
global.window.broken = { notFn: 42 };
eval(buildSource({
  key: "fn:broken.notFn#after", path: "broken.notFn", position: "after",
  hookCode: null, replacement: null,
  trace: { args: true, ret: true, stack: false }, nonOverridable: false,
}));
check("错误路径: 报告 phase=error",
  reports.some((r) => r.phase === "error" && r.error.includes("not a function")));

// ---- 幂等：同 key 重复注入 ----
reports = freshEnv();
global.window.dup = { f: function f() { return 1; } };
const opts = {
  key: "fn:dup.f#after", path: "dup.f", position: "after",
  hookCode: null, replacement: null,
  trace: { args: false, ret: true, stack: false }, nonOverridable: false,
};
eval(buildSource(opts));
eval(buildSource(opts));
global.window.dup.f();
const retCount = reports.filter((r) => r.phase === "return").length;
check("幂等: 重复注入只报一次", retCount === 1, `return reports=${retCount}`);

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);

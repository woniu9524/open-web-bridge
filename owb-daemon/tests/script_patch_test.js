/**
 * Fetch 脚本改写的 Node 单测（无浏览器）。
 * 从 background.js 提取真实 globToRegExp / applyScriptPatch / PROXY_PROBE_SNIPPET：
 *   glob 匹配语义、prepend 顺序、proxy_probe 探针实际行为（每 key 只报一次、
 *   getter 不炸、幂等）、补丁后脚本仍可执行。
 *
 * 运行：node owb-daemon/tests/script_patch_test.js
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const bg = fs.readFileSync(
  path.join(__dirname, "..", "..", "owb-extension", "background.js"), "utf8")
  .replace(/\r\n/g, "\n");

function extractFn(name) {
  const m = bg.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n}`));
  if (!m) {
    console.error(`[FAIL] 无法提取 ${name}`);
    process.exit(1);
  }
  return m[0];
}
const snippetMatch = bg.match(/const PROXY_PROBE_SNIPPET = `([\s\S]*?)`;\n/);
if (!snippetMatch) {
  console.error("[FAIL] 无法提取 PROXY_PROBE_SNIPPET");
  process.exit(1);
}
const PROXY_PROBE_SNIPPET = snippetMatch[1];

eval(extractFn("globToRegExp") + "\nglobalThis.globToRegExp = globToRegExp;");
eval(extractFn("applyScriptPatch") + "\nglobalThis.applyScriptPatch = applyScriptPatch;");

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`[PASS] ${name}`); }
  else { failed++; console.log(`[FAIL] ${name}  -- ${detail}`); }
}

// ---- globToRegExp ----
check("glob: **/sdenv-*.js 命中",
  globToRegExp("**/sdenv-*.js").test("https://a.b/c/sdenv-v123.js"));
check("glob: 不命中其他路径",
  !globToRegExp("**/sdenv-*.js").test("https://a.b/c/app.js"));
check("glob: ? 单字符",
  globToRegExp("*://a.b/f?.js").test("https://a.b/f1.js") &&
  !globToRegExp("*://a.b/f?.js").test("https://a.b/f12.js"));
check("glob: 点号转义",
  !globToRegExp("*.example.com/*").test("https://xXexampleYcom/z"));

// ---- applyScriptPatch: prepend ----
const orig = `window.__targetRan = (window.__targetRan || 0) + 1;`;
const prepended = applyScriptPatch(orig, { type: "prepend", code: `window.__prepended = true;` });
check("prepend: 探针在前", prepended.indexOf("__prepended") < prepended.indexOf("__targetRan"));

// ---- applyScriptPatch: proxy_probe 实际行为 ----
const patched = applyScriptPatch(orig, { type: "proxy_probe" });

const reports = [];
// 真实浏览器里 window === globalThis，探针 shadow 的是 window.navigator
global.window = globalThis;
global.location = { href: "https://test.local/" };
// Node 24 的全局 navigator/screen 是 getter-only，需要 defineProperty 覆盖
Object.defineProperty(globalThis, "navigator", {
  value: { userAgent: "TestUA/1.0", platform: "TestOS" }, configurable: true });
Object.defineProperty(globalThis, "screen", {
  value: { width: 1920, height: 1080 }, configurable: true });
global.__owbReport = (s) => reports.push(JSON.parse(s));
global.Proxy = Proxy;
global.Reflect = Reflect;
global.Set = Set;
// shadow 用 defineProperty 需要 window 是普通对象（OK）

eval(patched);
check("probe: 目标脚本在补丁后执行", global.window.__targetRan === 1);

// 模拟脚本读环境
const ua1 = global.navigator.userAgent;
const ua2 = global.navigator.userAgent; // 第二次同 key 不应重复上报
const w = global.screen.width;
check("probe: navigator.userAgent 上报一次",
  reports.filter((r) => r.get === "navigator.userAgent").length === 1,
  JSON.stringify(reports));
check("probe: screen.width 上报", reports.some((r) => r.get === "screen.width"));
check("probe: 真实值可读到", ua1 === "TestUA/1.0" && ua2 === ua1 && w === 1920);

// 幂等：再次 eval 同补丁不重复装探针
eval(patched);
global.navigator.platform;
check("probe: 重复注入幂等",
  reports.filter((r) => r.get === "navigator.platform").length === 1,
  JSON.stringify(reports));

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);

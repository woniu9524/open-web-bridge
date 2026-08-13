/**
 * env_compare 采集器的 Node 单测（无浏览器）。
 * 从 background.js 提取真实 ENV_COLLECT_EXPR / ENV_FEATURES_EXPR / 探针清单：
 *   通用采集器（值/函数标签/对象标签/undefined/异常）、
 *   features 表达式可解析性（不执行，浏览器专属）、探针清单覆盖关键项。
 *
 * 运行：node daemon/tests/env_compare_test.js
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const bg = fs.readFileSync(
  path.join(__dirname, "..", "..", "extension", "background.js"), "utf8")
  .replace(/\r\n/g, "\n");

function grab(re, name) {
  const m = bg.match(re);
  if (!m) {
    console.error(`[FAIL] 无法提取 ${name}`);
    process.exit(1);
  }
  return m[0];
}

// 提取探针清单与表达式定义，按原样 eval 重建
eval(grab(/const ENV_PROBES_A = \[[\s\S]*?\];/, "ENV_PROBES_A") + "\nglobalThis.ENV_PROBES_A = ENV_PROBES_A;");
eval(grab(/const ENV_COLLECT_EXPR = \(probes\) => `[\s\S]*?`;\n/, "ENV_COLLECT_EXPR") + "\nglobalThis.ENV_COLLECT_EXPR = ENV_COLLECT_EXPR;");
const featuresDecl = grab(/const ENV_FEATURES_EXPR = `[\s\S]*?`;\n/, "ENV_FEATURES_EXPR");
eval(featuresDecl + "\nglobalThis.ENV_FEATURES_EXPR = ENV_FEATURES_EXPR;");

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`[PASS] ${name}`); }
  else { failed++; console.log(`[FAIL] ${name}  -- ${detail}`); }
}

// ---- 通用采集器行为 ----
global.window = globalThis;
Object.defineProperty(globalThis, "navigator", {
  value: {
    userAgent: "TestUA/1.0",
    webdriver: false,
    languages: ["zh-CN", "en"],
    plugins: { length: 5 },
    hasFocus: function hasFocus() {},
  },
  configurable: true,
});

const out = eval(ENV_COLLECT_EXPR([
  "navigator.userAgent",
  "navigator.webdriver",
  "navigator.languages",
  "navigator.plugins.length",
  "navigator.hasFocus",
  "navigator.noSuchProp",
  "navigator.connection.type.deep",
]));
check("采集: 字符串值", out["navigator.userAgent"] === "TestUA/1.0");
check("采集: 布尔值", out["navigator.webdriver"] === false);
check("采集: 数组 join", out["navigator.languages"] === "zh-CN,en");
check("采集: 嵌套数字", out["navigator.plugins.length"] === 5);
check("采集: 函数压标签", out["navigator.hasFocus"] === "[function]");
check("采集: undefined 属性", out["navigator.noSuchProp"] === undefined);
check("采集: 深层异常容错", String(out["navigator.connection.type.deep"]).includes("[err"),
  String(out["navigator.connection.type.deep"]));

// ---- features 表达式可解析（不执行，DOM/canvas 是浏览器专属）----
let parseOk = true;
try {
  new Function(`return (${ENV_FEATURES_EXPR});`);
} catch (e) {
  parseOk = false;
  console.error("  parse error:", e.message);
}
check("features 表达式语法有效", parseOk);

// ---- 探针清单覆盖关键检测项 ----
check("清单: 含 webdriver", ENV_PROBES_A.includes("navigator.webdriver"));
check("清单: 含 plugins.length", ENV_PROBES_A.includes("navigator.plugins.length"));
check("清单: 含 UA", ENV_PROBES_A.includes("navigator.userAgent"));

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);

/**
 * oracle_call 页面包装器的 Node 单测（无浏览器）。
 * 从 background.js 提取真实 ORACLE_EXPR 验证：调用目标函数、
 * freeze 冻结/恢复 Date.now 与 Math.random、错误路径、Promise 结果。
 *
 * 运行：node owb-daemon/tests/oracle_test.js
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const bg = fs.readFileSync(
  path.join(__dirname, "..", "..", "owb-extension", "background.js"), "utf8");
const m = bg.match(/const ORACLE_EXPR = `([\s\S]*?)`;/);
if (!m) {
  console.error("[FAIL] 无法从 background.js 提取 ORACLE_EXPR");
  process.exit(1);
}
const ORACLE_EXPR = m[1];

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`[PASS] ${name}`); }
  else { failed++; console.log(`[FAIL] ${name}  -- ${detail}`); }
}

global.window = {};
const oracle = eval(ORACLE_EXPR);

(async () => {
  // 目标函数：使用 Date.now / Math.random 计算结果
  let nowCalls = 0;
  window.sign = function sign(input) {
    return `sig(${input})@${Date.now()}/${Math.random().toFixed(4)}`;
  };

  // freeze 模式
  const realNow = Date.now, realRand = Math.random;
  const r1 = await oracle("sign", ["abc"], true);
  check("freeze: ok + value", r1.ok === true && r1.value.startsWith("sig(abc)@"),
    JSON.stringify(r1));
  check("freeze: 元数据冻结单值",
    r1.meta.frozen === true && r1.meta.dateNow.length === 1 && r1.meta.mathRandom.length === 1);
  check("freeze: Date.now 已恢复", Date.now === realNow && Math.random === realRand);

  // freeze 模式下结果内的时间戳应等于冻结值
  const frozenTs = r1.meta.dateNow[0];
  check("freeze: 结果内时间戳=冻结值", r1.value.includes("@" + frozenTs),
    `${r1.value} vs ${frozenTs}`);

  // 非 freeze 模式：记录实际值
  const r2 = await oracle("sign", ["x"], false);
  check("record: 记录实际调用值", r2.ok && r2.meta.dateNow.length >= 1,
    JSON.stringify(r2.meta));

  // window. 前缀路径
  const r3 = await oracle("window.sign", ["y"], true);
  check("window. 前缀路径解析", r3.ok && r3.value.startsWith("sig(y)@"));

  // Promise 结果
  window.asyncSign = async function (v) { return "async:" + v; };
  const r4 = await oracle("asyncSign", ["z"], true);
  check("Promise 结果 await", r4.ok && r4.value === "async:z", JSON.stringify(r4));

  // 错误路径
  const r5 = await oracle("no.such.fn", [], true);
  check("错误路径: ok=false", r5.ok === false && r5.error.includes("not a function"),
    JSON.stringify(r5));

  console.log(`\n${passed}/${passed + failed} passed`);
  process.exit(failed ? 1 : 0);
})();

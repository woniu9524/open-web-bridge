/**
 * 无头测试总入口：跑 tests/ 下所有不需要外部依赖的测试 + 语法闸门。
 *
 * 为什么不继续用 package.json 里的 `&&` 链：
 *   1. `&&` 首败即停——一次运行只看得到第一个失败点；
 *   2. 加测试要手动改脚本，于是 18 个测试里有 10 个**从来没被 npm test 触发过**
 *      （扩展侧 6 组页面表达式测试、2 个 hooks 模板、relay 集成、har daemon
 *      集成全在网外），而它们恰恰覆盖着最脆的那部分代码：注入表达式一旦写错
 *      转义，service worker 直接起不来。
 * 这里按目录约定自动收集：新增 *_test.js 自动进套件，不需要再改这个文件。
 *
 * 运行：npm test
 *   真浏览器 / curl-impersonate 的那两个各有独立脚本（npm run test:browser
 *   / test:replay），它们需要外部环境，不该让无头 CI 变红。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const DAEMON_DIR = path.resolve(__dirname, "..");

// 需要真 Chrome / curl-impersonate 二进制，不进无头总入口
const NEEDS_EXTERNAL = new Set(["e2e_browser_test.js", "verify_replay_test.js"]);

// 语法闸门。background.js 是 6000+ 行、内嵌十几个模板字面量页面表达式的单文件，
// 一个反斜杠写错不会有编译期报错，只会在浏览器里静默行为异常，或者整个 SW 起不来
// 只能人工去 chrome://extensions 点重载（BUG-122 就是这么炸的）。该文件头部自己
// 推荐了 node --check，但此前没有任何入口真的执行它。
const SYNTAX_GATES = [
  "owb-extension/background.js",
  "owb-extension/popup.js",
  "owb-extension/hooks/xhr.js",
  "owb-extension/hooks/fetch.js",
  "owb-extension/hooks/crypto.js",
  "owb-extension/hooks/fn_hook.js",
  "owb-extension/har/builder.js",
  "owb-extension/har/stats.js",
  "owb-daemon/src/server.js",
  "owb-daemon/src/cli.js",
  "owb-daemon/src/evidence.js",
];

function run(cmd, args, cwd) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, {
      cwd,
      stdio: ["ignore", "inherit", "inherit"],
      env: {
        ...process.env,
        // 扩展不在场时不要为每次调用等满 ~35s 退避：测试断言的是「参数送达了」，
        // NO_EXTENSION 本身就是可接受结果（这个逃生口正是为自动化准备的）。
        OWB_NO_EXT_RETRY: "1",
      },
    });
    p.on("close", (code) => resolve(code === 0));
    p.on("error", () => resolve(false));
  });
}

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;

const results = [];

// ---- 1. 语法闸门 ----
console.log(bold("\n=== syntax (node --check) ==="));
let syntaxOk = true;
for (const rel of SYNTAX_GATES) {
  const abs = path.join(REPO_ROOT, rel);
  if (!fs.existsSync(abs)) continue;
  const ok = await run(process.execPath, ["--check", abs], REPO_ROOT);
  if (!ok) { syntaxOk = false; console.log(red(`  ✗ ${rel}`)); }
}
if (syntaxOk) console.log(green(`  ✓ ${SYNTAX_GATES.length} files parse`));
results.push({ name: "syntax", ok: syntaxOk });

// ---- 2. 测试文件（目录约定收集）----
const files = fs.readdirSync(__dirname)
  .filter((f) => f.endsWith("_test.js") && !NEEDS_EXTERNAL.has(f))
  .sort();

for (const f of files) {
  console.log(bold(`\n=== ${f} ===`));
  const ok = await run(process.execPath, [path.join("tests", f)], DAEMON_DIR);
  results.push({ name: f, ok });
}

// ---- 3. 汇总 ----
const failed = results.filter((r) => !r.ok);
console.log(bold("\n=== summary ==="));
for (const r of results) {
  console.log(`  ${r.ok ? green("PASS") : red("FAIL")}  ${r.name}`);
}
console.log(
  `\n${results.length - failed.length}/${results.length} suites passed` +
  (failed.length ? red(`  (${failed.map((r) => r.name).join(", ")})`) : ""),
);
console.log(
  `skipped (need external deps): ${[...NEEDS_EXTERNAL].join(", ")} ` +
  "— npm run test:browser / test:replay\n",
);

process.exitCode = failed.length ? 1 : 0;

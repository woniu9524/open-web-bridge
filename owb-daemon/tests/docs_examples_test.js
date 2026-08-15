/**
 * 文档示例 lint：把 owb-skills/owb 下（含 references/）所有 `owb ...` 示例抽出来，
 * 逐条确认它**确实是一条存在的命令**。
 *
 * 为什么需要这条测试（BUG-119 / BUG-120 的共同教训）：
 * 现有测试跑的命令和文档教用户写的命令是**两套东西**。实测把 SKILL.md 里
 * 15 条可证伪的声明逐条对拍，13 条行为描述全对、2 条可执行示例全错——
 * 因为前者被测试覆盖，后者一条都没有。
 *   owb flow save 周报    → BAD_ARGS: name is required   （BUG-119）
 *   owb debug oracle      → 未知命令：debug              （BUG-120）
 *   owb file download     → 未知命令：file               （BUG-120）
 *
 * 这里只做**静态**校验（命令名解析得出来），不真的执行——执行需要浏览器、
 * 会产生副作用，且很多示例带占位符。命令名这一层足以拦住"文档里写了一条
 * 根本不存在的命令"这类问题。
 *
 * 运行：node owb-daemon/tests/docs_examples_test.js
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { COMMANDS, GROUPS, parseArgv } from "../src/cli.js";
import { makeChecker } from "./kit.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(__dirname, "../../owb-skills/owb");

const { check, summarize } = makeChecker();

// 非命令的伪 owb 行：安装引导、占位符演示等
const NOT_COMMANDS = new Set(["setup", "skill", "call", "help", "cdp"]);

/** 从 markdown 里抽出 ```bash 代码块中的 owb 调用行。 */
function extractOwbLines(md) {
  const out = [];
  const blocks = md.match(/```bash\n[\s\S]*?```/g) || [];
  for (const b of blocks) {
    for (let line of b.split("\n")) {
      line = line.replace(/\\$/, "").trim();
      if (!line.startsWith("owb ")) continue;
      // 砍掉行尾注释与管道/重定向
      line = line.split(/\s+#\s/)[0].split(/\s*[|>]\s*/)[0].trim();
      out.push(line);
    }
  }
  return out;
}

/** 解析一行示例，返回它落到哪条命令（或 null）。 */
function resolveCommand(line) {
  // 粗切词：引号内的内容当作一个整体，避免把 "竞品定价调研" 切开
  const toks = line.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  const argv = toks.slice(1).map((t) => t.replace(/^['"]|['"]$/g, ""));
  const { positionals } = parseArgv(argv);
  if (!positionals.length) return { special: "bare" }; // 裸 `owb` 自检
  const first = positionals[0];
  if (NOT_COMMANDS.has(first)) return { special: first };
  const two = positionals.slice(0, 2).join(" ");
  if (COMMANDS.has(two)) return { cmd: two };
  if (COMMANDS.has(first)) return { cmd: first };
  return null;
}

// 先自证这个检测器不是摆设：BUG-120 里那三条真实的错误写法必须被判为不存在，
// 而它们各自的正确写法必须被判为存在。否则上面那条全绿毫无意义。
for (const bad of ["owb debug oracle", "owb file download", "owb fetch"]) {
  check(`检测器认得出坏写法：${bad}`, resolveCommand(bad) === null,
    JSON.stringify(resolveCommand(bad)));
}
for (const good of ["owb oracle", "owb download", "owb file fetch",
                    "owb debug break-xhr", "owb flow save 周报"]) {
  check(`检测器认得出好写法：${good}`, resolveCommand(good) !== null);
}

// skill 现在是 SKILL.md + references/ 子目录。这里必须**递归**扫——
// 只扫顶层的话，附文件一份都查不到，测试会「全绿」但其实只检查了 SKILL.md。
function collectMd(dir, prefix = "") {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...collectMd(path.join(dir, e.name), rel));
    else if (e.name.endsWith(".md")) out.push(rel);
  }
  return out;
}

const files = collectMd(SKILL_DIR);
check("找得到技能文档", files.length > 0, files.join(","));
check("附文件也扫到了（不只是 SKILL.md）",
  files.some((f) => f.includes("/")), files.join(","));

let total = 0;
const broken = [];
for (const f of files) {
  const md = fs.readFileSync(path.join(SKILL_DIR, f), "utf8");
  for (const line of extractOwbLines(md)) {
    total++;
    if (!resolveCommand(line)) broken.push(`${f}: ${line}`);
  }
}

console.log(`  （扫描 ${files.length} 份文档，抽出 ${total} 条 owb 示例）`);
check(
  "文档里每条 owb 示例都是存在的命令",
  broken.length === 0,
  broken.slice(0, 12).join("\n           ") +
    (broken.length > 12 ? `\n           …共 ${broken.length} 条` : ""),
);

// 组名本身不是命令——BUG-120 的直接回归：`owb debug ...` 里 debug 是前缀，
// 但 `owb file download` 里 file 不是。别再让文档/help 混淆这两者。
for (const g of Object.keys(GROUPS)) {
  const keys = Object.keys(GROUPS[g]);
  const prefixed = keys.filter((k) => k.startsWith(`${g} `));
  const bare = keys.filter((k) => !k.startsWith(`${g} `));
  if (prefixed.length && bare.length) {
    check(
      `[${g}] 混用前缀的组，其顶层命令确实是顶层`,
      bare.every((k) => COMMANDS.has(k)),
      JSON.stringify(bare),
    );
  }
}

process.exit(summarize());

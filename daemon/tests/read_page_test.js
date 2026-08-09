/**
 * read_page snapshot 页面表达式的 Node 单测（无浏览器）。
 * 从 background.js 提取真实 READ_PAGE_SNAPSHOT_EXPR（与 state_test.js 同款
 * 正则提取 + eval），用最小 DOM mock（querySelectorAll / getAttribute /
 * setAttribute / getBoundingClientRect）验证：
 *   ref 首次分配与二次快照复用（稳定性）、role 推断、name 优先级、
 *   不可见跳过、行格式、hash 同行稳定、max_nodes 截断。
 *
 * 运行：node daemon/tests/read_page_test.js
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const bg = fs.readFileSync(
  path.join(__dirname, "..", "..", "extension", "background.js"), "utf8");
const snapMatch = bg.match(
  /const READ_PAGE_SNAPSHOT_EXPR = \(nextRef, maxNodes\) => `([\s\S]*?)`;\n/);
if (!snapMatch) {
  console.error("[FAIL] 无法从 background.js 提取 READ_PAGE_SNAPSHOT_EXPR");
  process.exit(1);
}
// 提取的是模板字面量内部文本，拼回箭头函数再 eval（与扩展侧同一模板处理管线）
const makeExpr = eval("(nextRef, maxNodes) => `" + snapMatch[1] + "`");

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`[PASS] ${name}`); }
  else { failed++; console.log(`[FAIL] ${name}  -- ${detail}`); }
}

// ---- 最小 DOM mock ----
function makeEl(tag, attrs = {}, opts = {}) {
  return {
    tagName: tag.toUpperCase(),
    _attrs: { ...attrs },
    innerText: opts.innerText !== undefined ? opts.innerText : "",
    value: opts.value,
    _rect: opts.rect || { width: 10, height: 10, x: 0, y: 0 },
    getAttribute(n) { return n in this._attrs ? this._attrs[n] : null; },
    setAttribute(n, v) { this._attrs[n] = String(v); },
    getBoundingClientRect() { return this._rect; },
  };
}

function setDoc(els) {
  global.document = {
    title: "mock-page",
    querySelectorAll() { return els; },
  };
  global.location = { href: "http://target.local/page" };
}

// 与页面表达式一致的哈希算法（用于交叉验证）
function hashOf(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
  return h;
}

function runSnapshot(els, nextRef, maxNodes = 400) {
  setDoc(els);
  return eval(makeExpr(nextRef, maxNodes));
}

// ---- 场景 1：role 推断 + name 优先级 + 首次 ref 分配 ----
const link = makeEl("a", { href: "/x" }, { innerText: "首页" });
const btn = makeEl("button", {}, { innerText: "搜索" });
const cbx = makeEl("input", { type: "checkbox", "aria-label": "记住我" });
const sel = makeEl("select", { placeholder: "城市" });
const ipt = makeEl("input", { placeholder: "关键词" }, { value: "已填值" });
const iptVal = makeEl("input", {}, { value: "仅值兜底" });
const h1 = makeEl("h1", {}, { innerText: "知乎" });
const img = makeEl("img", { alt: "头像" });
const tabEl = makeEl("div", { role: "tab", "aria-label": "标签页" });
const hidden = makeEl("button", {}, { innerText: "不可见", rect: { width: 0, height: 0 } });
const els1 = [link, btn, cbx, sel, ipt, iptVal, h1, img, tabEl, hidden];

const r1 = runSnapshot(els1, 1);
const byName = (n) => r1.nodes.find((x) => x.name === n) || {};

check("role 推断 a[href]→link", byName("首页").role === "link", JSON.stringify(byName("首页")));
check("role 推断 button→button", byName("搜索").role === "button");
check("role 推断 input[checkbox]→checkbox", byName("记住我").role === "checkbox");
check("role 推断 select→combobox", byName("城市").role === "combobox");
check("显式 role 属性优先", byName("标签页").role === "tab");
check("role 推断 h1→heading", byName("知乎").role === "heading");
check("role 推断 img[alt]→img", byName("头像").role === "img");

check("name 优先级 aria-label 最高", byName("记住我").name === "记住我");
check("name 优先级 placeholder > value", byName("关键词").name === "关键词",
  byName("关键词").name);
check("name 兜底 value", byName("仅值兜底").name === "仅值兜底");
check("name 兜底 alt", byName("头像").name === "头像");
check("name 兜底 innerText", byName("搜索").name === "搜索");

check("不可见（无布局盒）跳过",
  !r1.nodes.some((x) => x.name === "不可见") && r1.nodes.length === 9,
  `nodes=${r1.nodes.length}`);

check("ref 首次分配按文档序递增",
  byName("首页").ref === "e1" && byName("搜索").ref === "e2" &&
  byName("记住我").ref === "e3" && byName("城市").ref === "e4" &&
  byName("关键词").ref === "e5" && byName("仅值兜底").ref === "e6" &&
  byName("标签页").ref === "e7",
  JSON.stringify(r1.nodes.map((x) => [x.name, x.ref])));
check("heading/img 不打 ref",
  byName("知乎").ref === null && byName("头像").ref === null);
check("refsAssigned / nextRef 回传",
  r1.refsAssigned === 7 && r1.nextRef === 8,
  `assigned=${r1.refsAssigned} next=${r1.nextRef}`);
check("data-owb-ref 属性已写到元素上",
  btn.getAttribute("data-owb-ref") === "e2" && cbx.getAttribute("data-owb-ref") === "e3");

check("行格式 @e2 button \"搜索\"",
  byName("搜索").line === '@e2 button "搜索"', byName("搜索").line);
check("行格式 heading level",
  byName("知乎").line === 'heading "知乎" level=1', byName("知乎").line);
check("行格式 img",
  byName("头像").line === 'img "头像"', byName("头像").line);

// ---- 场景 2：二次快照复用 ref（同文档内稳定） ----
const r2 = runSnapshot(els1, r1.nextRef);
check("二次快照 ref 复用原值",
  byName2(r2, "搜索").ref === "e2" && byName2(r2, "标签页").ref === "e7" &&
  r2.refsAssigned === 0 && r2.nextRef === r1.nextRef,
  `assigned=${r2.refsAssigned}`);
function byName2(r, n) { return r.nodes.find((x) => x.name === n) || {}; }

check("hash 同行稳定（跨快照一致）",
  byName2(r2, "搜索").hash === byName("搜索").hash &&
  byName2(r2, "知乎").hash === byName("知乎").hash);
check("hash = h*31+charCodeAt(line)",
  byName("搜索").hash === hashOf(byName("搜索").line));

// 新元素出现 → 从 nextRef 续编，旧 ref 不受影响
const link2 = makeEl("a", { href: "/new" }, { innerText: "新链接" });
const r3 = runSnapshot([...els1, link2], r2.nextRef);
check("新增元素从 nextRef 续编",
  r3.nodes.find((x) => x.name === "新链接").ref === "e8" &&
  r3.nodes.find((x) => x.name === "搜索").ref === "e2",
  JSON.stringify(r3.nodes.filter((x) => x.ref).map((x) => [x.name, x.ref])));

// 文本变化 → line 变 → hash 变（增量 diff 的原料）
btn.innerText = "搜索一下";
const r4 = runSnapshot(els1, r3.nextRef);
check("同名元素文本变化 → hash 变化",
  r4.nodes.find((x) => x.ref === "e2").hash !== byName("搜索").hash &&
  r4.nodes.find((x) => x.ref === "e2").line === '@e2 button "搜索一下"',
  r4.nodes.find((x) => x.ref === "e2").line);

// ---- 场景 3：max_nodes 截断 ----
const r5 = runSnapshot(els1, 1, 3);
check("max_nodes 截断",
  r5.nodes.length === 3 && r5.truncated === true,
  `nodes=${r5.nodes.length} truncated=${r5.truncated}`);

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);

/**
 * read_page snapshot 页面表达式的 Node 单测（无浏览器）。
 * 从 background.js 提取真实 READ_PAGE_SNAPSHOT_EXPR（与 state_test.js 同款
 * 正则提取 + eval），用最小 DOM mock（querySelectorAll / getAttribute /
 * setAttribute / getBoundingClientRect）验证：
 *   ref 首次分配与二次快照复用（稳定性）、role 推断、name 优先级、
 *   不可见跳过、行格式、hash 同行稳定、max_nodes 截断。
 *
 * 运行：node owb-daemon/tests/read_page_test.js
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const bg = fs.readFileSync(
  path.join(__dirname, "..", "..", "owb-extension", "background.js"), "utf8")
  .replace(/\r\n/g, "\n");
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
// BUG-105 回归用例需要 el.textContent（可以是纯空白）+ el.querySelector
// 递归子元素找 img[alt] 兜底，所以这里补一个极简选择器匹配（只认
// nameOf() 实际用到的 "tag[attr], [attr]" 这种形状，不是通用 CSS 引擎）。
function matchesSimpleSelector(el, sel) {
  const m = sel.trim().match(/^([a-zA-Z]*)((?:\[[a-zA-Z-]+\])*)$/);
  if (!m) return false;
  const [, tag, attrsPart] = m;
  if (tag && el.tagName !== tag.toUpperCase()) return false;
  for (const [, name] of (attrsPart || "").matchAll(/\[([a-zA-Z-]+)\]/g)) {
    if (el.getAttribute(name) === null) return false;
  }
  return true;
}
function queryFirst(children, selectorList) {
  const selectors = selectorList.split(",").map((s) => s.trim());
  const stack = [...children];
  while (stack.length) {
    const el = stack.shift();
    if (selectors.some((s) => matchesSimpleSelector(el, s))) return el;
    if (el._children) stack.push(...el._children);
  }
  return null;
}
function makeEl(tag, attrs = {}, opts = {}) {
  return {
    tagName: tag.toUpperCase(),
    _attrs: { ...attrs },
    _children: opts.children || [],
    innerText: opts.innerText !== undefined ? opts.innerText : "",
    // textContent 独立于 innerText：不受 CSS 可见性影响，且会把子元素间的
    // 纯空白文本节点也算进去（BUG-105 就卡在这一点上）。不显式传就跟
    // innerText 一致，行为贴近没有子元素时的真实 DOM。
    textContent: opts.textContent !== undefined ? opts.textContent :
      (opts.innerText !== undefined ? opts.innerText : ""),
    value: opts.value,
    _rect: opts.rect || { width: 10, height: 10, x: 0, y: 0 },
    getAttribute(n) { return n in this._attrs ? this._attrs[n] : null; },
    setAttribute(n, v) { this._attrs[n] = String(v); },
    getBoundingClientRect() { return this._rect; },
    querySelector(sel) { return queryFirst(this._children, sel); },
    // 只认 nameOf() 实际调用的 closest("label")，不是真的沿父链走。
    closest(sel) { return sel === "label" ? (opts.labelWrap || null) : null; },
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

// ---- 场景 4：UX-80 contenteditable 也要拿到 ref ----
// role 落在 generic（不在 INTERACTIVE 表里），靠 el.isContentEditable 兜底，
// 否则富文本编辑区在 ref 工作流里完全不可寻址。
const ce = makeEl("div", { contenteditable: "true" }, { innerText: "正文编辑区" });
ce.isContentEditable = true;
const plainDiv = makeEl("div", { role: "presentation" }, { innerText: "装饰块" });
const r6 = runSnapshot([ce, plainDiv], 1);
const ceNode = r6.nodes.find((x) => x.name === "正文编辑区") || {};
const plainNode = r6.nodes.find((x) => x.name === "装饰块") || {};
check("UX-80 contenteditable 分到 ref",
  ceNode.ref === "e1" && ce.getAttribute("data-owb-ref") === "e1",
  JSON.stringify(ceNode));
check("UX-80 普通非交互元素仍不分 ref",
  plainNode.ref === null, JSON.stringify(plainNode));

// ---- 场景 5：行内补充信息（checked / href / type / disabled / values）----
const cbOn = makeEl("input", { type: "checkbox", "aria-label": "订阅" });
cbOn.checked = true;
const cbOff = makeEl("input", { type: "checkbox", "aria-label": "退订" });
cbOff.checked = false;
const mail = makeEl("input", { type: "email", "aria-label": "邮箱" });
mail.required = true;
const linkHref = makeEl("a", { href: "/detail?id=7" }, { innerText: "详情" });
const btnOff = makeEl("button", {}, { innerText: "提交" });
btnOff.disabled = true;
const r7 = runSnapshot([cbOn, cbOff, mail, linkHref, btnOff], 1);
const lineOf = (n) => (r7.nodes.find((x) => x.name === n) || {}).line || "";
check("UX-128 checkbox 显示 checked", / checked$/.test(lineOf("订阅")), lineOf("订阅"));
check("UX-128 未勾显示 unchecked", / unchecked$/.test(lineOf("退订")), lineOf("退订"));
check("UX-130 input type + required", /type=email required/.test(lineOf("邮箱")), lineOf("邮箱"));
check("UX-180 链接带 href", /href=.*\/detail\?id=7/.test(lineOf("详情")), lineOf("详情"));
check("BUG-24 disabled 元素标注", / disabled$/.test(lineOf("提交")), lineOf("提交"));

// ---- 场景 6：UX-105 表单控件靠 name 兜底命名 ----
const bare = makeEl("input", { type: "text", name: "username" });
const r8 = runSnapshot([bare], 1);
check("UX-105 无 label 的输入框用 name 兜底",
  (r8.nodes[0] || {}).name === "username", JSON.stringify(r8.nodes[0]));

// ---- 场景 7：BUG-105 空白 textContent 不该挡住图片 alt 兜底 ----
// 真实场景：<a href="..."> <img alt="Sony" ...> </a>，img 前后是源码缩进
// 换行留下的纯空白文本节点。textContent 会拿到"  "（两个空格）——JS 里
// 非空字符串是 truthy，如果不 trim 就会把 BUG-71 的 img[alt] 兜底堵死。
const brandImg = makeEl("img", { alt: "Sony" });
const brandLink = makeEl("a", { href: "/brand/sony" },
  { innerText: "", textContent: "  ", children: [brandImg] });
const r9 = runSnapshot([brandLink], 1);
check("BUG-105 空白 textContent 不挡 img alt 兜底",
  (r9.nodes[0] || {}).name === "Sony", JSON.stringify(r9.nodes[0]));

// 有真实可见文字时，文字依旧优先于子元素 img 的 alt——确认 BUG-105 的
// trim() 修复没有误伤"链接本来就有文字"这条更常见的路径。
const labeledImg = makeEl("img", { alt: "图标" });
const labeledLink = makeEl("a", { href: "/x" },
  { innerText: "查看详情", children: [labeledImg] });
const r10 = runSnapshot([labeledLink], 1);
check("有文字时文字优先于 img alt（未被 BUG-105 修复误伤）",
  (r10.nodes[0] || {}).name === "查看详情", JSON.stringify(r10.nodes[0]));

// 同一隐患的姊妹路径：外层 <label> 只包着空白（没有直接可读文字），
// closest("label") 拿到的 innerText 一样是纯空白，不 trim 会挡住后面
// input 自己的 name 兜底。
const wrapLabel = makeEl("label", {}, { innerText: "  " });
const wrappedInput = makeEl("input", { type: "text", name: "search_q" },
  { labelWrap: wrapLabel });
const r11 = runSnapshot([wrappedInput], 1);
check("BUG-105 姊妹路径：label 纯空白 innerText 不挡 name 兜底",
  (r11.nodes[0] || {}).name === "search_q", JSON.stringify(r11.nodes[0]));

// ---- 场景 8：BUG-107 aria-hidden="true" 的元素该整个从快照里剔除 ----
// 实测大都会博物馆藏品页：每张部门卡片除了一个正常具名链接，还叠着一个
// class 带 "redundant-link"、aria-hidden="true" 的整卡覆盖点击层，
// 纯装饰/纯交互冗余，对无障碍技术本就该隐身。
const redundantLink = makeEl("a",
  { href: "/dept/african-art", "aria-hidden": "true" }, { innerText: "" });
const realLink = makeEl("a", { href: "/dept/african-art" },
  { innerText: "African Art" });
const r12 = runSnapshot([redundantLink, realLink], 1);
check("BUG-107 aria-hidden 元素不进快照",
  r12.nodes.length === 1 && r12.nodes[0].name === "African Art",
  JSON.stringify(r12.nodes));
check("BUG-107 skippedAriaHidden 计数",
  r12.skippedAriaHidden === 1, `skippedAriaHidden=${r12.skippedAriaHidden}`);

// 正常、没有 aria-hidden 的元素不受影响（防止误伤所有链接）
check("BUG-107 没有 aria-hidden 的元素不受影响",
  r12.nodes.some((x) => x.name === "African Art"));

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);

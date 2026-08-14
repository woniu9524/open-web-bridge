/**
 * mouse_click 的 AI 光标覆盖层页面表达式 Node 单测（无浏览器）。
 * 从 background.js 提取真实 CURSOR_OVERLAY_EXPR（与 read_page_test.js 同款
 * 正则提取 + eval），用最小 DOM mock（createElement/createElementNS/style/
 * appendChild/removeChild）+ 手动时钟 requestAnimationFrame 验证：
 *   单例幂等（二次 ensure 不重建 DOM）、moveTo 贝塞尔动画中途渐进且
 *   按时到达目标、clickFx 涟漪元素产生与超时清理。
 *
 * 运行：node owb-daemon/tests/mouse_click_test.js
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const bg = fs.readFileSync(
  path.join(__dirname, "..", "..", "owb-extension", "background.js"), "utf8")
  .replace(/\r\n/g, "\n");
const m = bg.match(/const CURSOR_OVERLAY_EXPR = `([\s\S]*?)`;\n/);
if (!m) {
  console.error("[FAIL] 无法从 background.js 提取 CURSOR_OVERLAY_EXPR");
  process.exit(1);
}
const SRC = m[1];

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`[PASS] ${name}`); }
  else { failed++; console.log(`[FAIL] ${name}  -- ${detail}`); }
}

// ---- 最小 DOM mock ----
const created = [];
function makeEl(tag) {
  return {
    tagName: String(tag).toUpperCase(),
    id: "",
    style: {},
    children: [],
    _attrs: {},
    setAttribute(n, v) { this._attrs[n] = String(v); },
    getAttribute(n) { return n in this._attrs ? this._attrs[n] : null; },
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) {
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
      return c;
    },
    offsetWidth: 0,
  };
}

const body = makeEl("body");
global.window = {};
global.document = {
  body,
  documentElement: makeEl("html"),
  createElement(tag) { const el = makeEl(tag); created.push(el); return el; },
  createElementNS(ns, tag) { const el = makeEl(tag); created.push(el); return el; },
};

// ---- rAF 手动时钟：tick() 每帧推进 16.7ms 并把时间戳喂给回调 ----
let virtualNow = 0;
const rafQueue = [];
global.requestAnimationFrame = (cb) => { rafQueue.push(cb); return rafQueue.length; };
function tick(frames = 1) {
  for (let i = 0; i < frames; i++) {
    virtualNow += 16.7;
    const q = rafQueue.splice(0, rafQueue.length);
    for (const cb of q) cb(virtualNow);
  }
}

function transformXY(el) {
  const mm = /translate3d\(([-\d.]+)px,([-\d.]+)px/.exec(el.style.transform || "");
  return mm ? { x: parseFloat(mm[1]), y: parseFloat(mm[2]) } : null;
}

(async () => {
  // ---- 场景 1：首次 ensure 创建覆盖层 ----
  const api1 = eval(SRC);
  check("返回 __owbCursor 单例（含 moveTo/clickFx）",
    api1 && typeof api1.moveTo === "function" && typeof api1.clickFx === "function"
    && global.window.__owbCursor === api1);
  check("容器挂到 body（z-index 拉满 + pointer-events:none）",
    body.children.length === 1
    && body.children[0].style.zIndex === "2147483647"
    && body.children[0].style.pointerEvents === "none",
    JSON.stringify(body.children[0] && body.children[0].style));
  const root = body.children[0];
  const cursor = root.children[0];
  check("光标为内联 SVG（主色 #2563eb + 白描边）",
    cursor && cursor.children[0] && cursor.children[0].tagName === "SVG"
    && cursor.children[0].children[0].getAttribute("fill") === "#2563eb"
    && cursor.children[0].children[0].getAttribute("stroke") === "#ffffff");
  check("初始位置在原点",
    cursor.style.transform === "translate3d(0px,0px,0)", cursor.style.transform);

  // ---- 场景 2：二次 ensure 幂等（不重建 DOM） ----
  const createdCount = created.length;
  const api2 = eval(SRC);
  check("二次 ensure 返回同一单例、不重建 DOM",
    api2 === api1 && body.children.length === 1 && created.length === createdCount,
    `created ${createdCount} -> ${created.length}`);

  // ---- 场景 3：moveTo 贝塞尔动画 ----
  let resolved = null;
  const p = api1.moveTo(300, 200, 450).then((v) => { resolved = v; });
  tick(5); // ~83ms：动画中途，不应已到位
  const mid = transformXY(cursor);
  check("动画中途渐进（未到位）",
    mid && (mid.x < 250 || mid.y < 180),
    JSON.stringify(mid));
  tick(30); // 累计 ~585ms > 450ms：必须完成
  await p;
  check("moveTo resolve 后位置到达目标",
    resolved && Math.abs(resolved.x - 300) < 0.01 && Math.abs(resolved.y - 200) < 0.01,
    JSON.stringify(resolved));
  check("光标 transform 落在目标点",
    cursor.style.transform === "translate3d(300px,200px,0)", cursor.style.transform);

  // duration=0：瞬移（无动画）
  const jump = await api1.moveTo(10, 10, 0);
  check("duration=0 瞬移到位",
    jump && jump.x === 10 && jump.y === 10
    && cursor.style.transform === "translate3d(10px,10px,0)", cursor.style.transform);
  await api1.moveTo(300, 200, 0); // 移回目标点，供 clickFx 定位

  // ---- 场景 4：clickFx 涟漪 ----
  const before = root.children.length;
  api1.clickFx();
  check("clickFx 产生涟漪元素",
    root.children.length === before + 1, `children=${root.children.length}`);
  const rip = root.children[root.children.length - 1];
  check("涟漪为圆形且 ~400ms 扩散淡出",
    rip.style.borderRadius === "50%" && /0\.4s/.test(rip.style.transition)
    && rip.style.opacity === "0" && /scale/.test(rip.style.transform),
    JSON.stringify(rip.style));
  await new Promise((r) => setTimeout(r, 500));
  check("涟漪随后自清理", root.children.length === before,
    `children=${root.children.length}`);

  console.log(`\n${passed}/${passed + failed} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("[FAIL] 测试异常:", e);
  process.exit(1);
});

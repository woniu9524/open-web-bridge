"use strict";
/**
 * HAR 产物加工：C7 重放脚本生成 / C8 录制对比 / C9 断言校验。
 * 纯函数、无浏览器依赖，daemon call_local 直接调，也可独立 import 做离线分析。
 *
 * 设计取舍：
 *  - 重放脚本只取「有响应的」entry（与 har builder 过滤一致），按时间序输出
 *  - 不自动重放签名类动态头（X-Sign/timestamp/nonce）——这些站点相关，
 *    生成时用占位符 + 注释提示；真正重放由 replay.js 的 curl-impersonate 兜底
 *  - diff/assert 按 method+url 归一化匹配（去掉 query 顺序差异由调用方保证）
 */

const METHODS_WITH_BODY = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// 取 HAR 里可直接重放的 entries（有响应、非 websocket、非 data:）
function replayableEntries(har) {
  const entries = (har && har.log && har.log.entries) || [];
  return entries.filter((e) => {
    if (!e.response || e.response.status == null) return false;
    const rt = e._resourceType;
    if (rt === "websocket") return false;
    if (!e.request || /^data:/i.test(e.request.url || "")) return false;
    return true;
  });
}

function headerMap(pairs) {
  const m = {};
  for (const { name, value } of pairs || []) {
    const k = String(name).toLowerCase();
    if (!(k in m)) m[k] = value; // 首个为准，避免重复
  }
  return m;
}

// 站点相关的动态签名头启发式：生成时打占位符标记，便于人工/脚本替换
const DYNAMIC_HEADER_HINT = /^(x-?sign|x-?token|x-?biz|x-?csrf|authorization|signature|nonce|timestamp|_signature|apisign|sign)$/i;

function splitStaticDynamicHeaders(headerPairs) {
  const staticH = [];
  const dynamicH = [];
  for (const { name, value } of headerPairs || []) {
    if (DYNAMIC_HEADER_HINT.test(name)) dynamicH.push({ name, value });
    else staticH.push({ name, value });
  }
  return { staticH, dynamicH };
}

// ---- C7: HAR → 重放脚本 ----

export function harToReplay(har, format = "python") {
  const entries = replayableEntries(har);
  if (!entries.length) return { format, count: 0, code: `# no replayable entries\n` };
  if (format === "curl") return { format, count: entries.length, code: toCurl(entries) };
  if (format === "node") return { format, count: entries.length, code: toNode(entries) };
  return { format: "python", count: entries.length, code: toPython(entries) };
}

function entryContext(e, idx) {
  const req = e.request;
  const { staticH, dynamicH } = splitStaticDynamicHeaders(req.headers);
  const url = JSON.stringify(req.url);
  const isBody = METHODS_WITH_BODY.has((req.method || "GET").toUpperCase());
  const postData = req.postData ? req.postData.text : null;
  return { idx, method: req.method || "GET", url, staticH, dynamicH, isBody, postData };
}

function toPython(entries) {
  const lines = [
    "# Auto-generated from HAR by Open Web Bridge.",
    "# 动态签名头（已标 <DYNAMIC>）需人工补；时序敏感的 nonce/timestamp 按需重算。",
    "import requests",
    "",
    "session = requests.Session()",
    "",
  ];
  for (const e of entries) {
    const c = entryContext(e, lines.length);
    lines.push(`# --- ${c.idx}: ${c.method} ${e.request.url} -> ${e.response.status} ---`);
    const headers = {};
    for (const { name, value } of c.staticH) headers[name] = value;
    for (const { name } of c.dynamicH) headers[name] = "<DYNAMIC>";
    // 去掉 content-length/encoding（requests 自管）
    delete headers["Content-Length"];
    delete headers["content-length"];
    lines.push(`resp = session.request(`);
    lines.push(`    method=${JSON.stringify(c.method)}, url=${c.url},`);
    if (Object.keys(headers).length) lines.push(`    headers=${JSON.stringify(headers, null, 2).split("\n").join("\n    ")},`);
    if (c.isBody && c.postData) lines.push(`    data=${JSON.stringify(c.postData)},`);
    lines.push(`    verify=False,`);
    lines.push(`)`);
    lines.push(`print(resp.status_code, len(resp.content))`);
    lines.push("");
  }
  return lines.join("\n");
}

function toCurl(entries) {
  const out = ["# Auto-generated from HAR by Open Web Bridge. Dynamic headers marked <DYNAMIC>."];
  for (const e of entries) {
    const c = entryContext(e, out.length);
    const parts = ["curl", "-s", "-X", c.method, c.url];
    for (const { name, value } of c.staticH) {
      parts.push("-H", JSON.stringify(`${name}: ${value}`));
    }
    for (const { name } of c.dynamicH) {
      parts.push("-H", JSON.stringify(`${name}: <DYNAMIC>`));
    }
    if (c.isBody && c.postData) {
      parts.push("--data-raw", JSON.stringify(c.postData));
    }
    out.push(parts.join(" \\\n  "));
    out.push("");
  }
  return out.join("\n");
}

function toNode(entries) {
  const lines = [
    "// Auto-generated from HAR by Open Web Bridge. Dynamic headers marked <DYNAMIC>.",
    "const fetch = (...a) => import('node-fetch').then(({ default: f }) => f(...a));",
    "",
    "(async () => {",
  ];
  for (const e of entries) {
    const c = entryContext(e, lines.length);
    const headers = {};
    for (const { name, value } of c.staticH) headers[name] = value;
    for (const { name } of c.dynamicH) headers[name] = "<DYNAMIC>";
    delete headers["Content-Length"];
    delete headers["content-length"];
    const opts = { method: c.method, headers };
    if (c.isBody && c.postData) opts.body = c.postData;
    lines.push(`  // ${c.idx}: ${c.method} ${e.request.url}`);
    lines.push(`  const r = await fetch(${c.url}, ${JSON.stringify(opts)});`);
    lines.push(`  console.log(r.status, (await r.text()).length);`);
  }
  lines.push("})();");
  return lines.join("\n");
}

// ---- C8: 录制对比（两份 HAR 按 method+urlPath 匹配）----

function urlKey(method, url) {
  let u;
  try { u = new URL(url); } catch (e) { return `${method} ${url}`; }
  return `${method} ${u.origin}${u.pathname}`;
}

export function harDiff(baseline, current) {
  const a = replayableEntries(baseline);
  const b = replayableEntries(current);
  const mapA = new Map();
  for (const e of a) mapA.set(urlKey(e.request.method, e.request.url), e);
  const mapB = new Map();
  for (const e of b) mapB.set(urlKey(e.request.method, e.request.url), e);
  const keysA = new Set(mapA.keys());
  const keysB = new Set(mapB.keys());
  const onlyInBaseline = [...keysA].filter((k) => !keysB.has(k));
  const onlyInCurrent = [...keysB].filter((k) => !keysA.has(k));
  const common = [...keysA].filter((k) => keysB.has(k));
  const statusChanged = [];
  const bodyChanged = [];
  const headersChanged = [];
  for (const k of common) {
    const ea = mapA.get(k), eb = mapB.get(k);
    const sa = ea.response.status, sb = eb.response.status;
    if (sa !== sb) statusChanged.push({ key: k, baseline: sa, current: sb });
    const ta = ea.response.content.text || "";
    const tb = eb.response.content.text || "";
    if (ta !== tb) bodyChanged.push({ key: k, baselineLen: ta.length, currentLen: tb.length });
    const ha = JSON.stringify(headerMap(ea.response.headers));
    const hb = JSON.stringify(headerMap(eb.response.headers));
    if (ha !== hb) headersChanged.push({ key: k });
  }
  return {
    baseline_entries: a.length,
    current_entries: b.length,
    only_in_baseline: onlyInBaseline,
    only_in_current: onlyInCurrent,
    status_changed: statusChanged,
    body_changed: bodyChanged.length,
    headers_changed: headersChanged.length,
    body_changed_details: bodyChanged.slice(0, 20),
    identical:
      !onlyInBaseline.length && !onlyInCurrent.length &&
      !statusChanged.length && !bodyChanged.length && !headersChanged.length,
  };
}

// ---- C9: 断言校验（校一份 HAR 是否满足断言集）----

export function harAssert(har, assertions) {
  const entries = replayableEntries(har);
  const results = [];
  let passed = 0, failed = 0;
  for (const a of assertions || []) {
    const r = { assertion: a, ok: false };
    try {
      if (a.type === "request_exists") {
        const re = new RegExp(a.url_pattern);
        r.ok = entries.some((e) => re.test(e.request.url));
        r.detail = r.ok ? "matched" : "no matching request";
      } else if (a.type === "request_absent") {
        const re = new RegExp(a.url_pattern);
        r.ok = !entries.some((e) => re.test(e.request.url));
        r.detail = r.ok ? "absent as expected" : "unexpectedly present";
      } else if (a.type === "response_status") {
        const re = new RegExp(a.url_pattern);
        const e = entries.find((x) => re.test(x.request.url));
        if (!e) { r.detail = "no matching request"; }
        else { r.ok = e.response.status === Number(a.status); r.detail = `got ${e.response.status}`; }
      } else if (a.type === "response_contains") {
        const re = new RegExp(a.url_pattern);
        const e = entries.find((x) => re.test(x.request.url));
        if (!e) { r.detail = "no matching request"; }
        else {
          const text = e.response.content.text || "";
          r.ok = text.includes(String(a.value));
          r.detail = r.ok ? "found" : "not found in body";
        }
      } else if (a.type === "min_requests") {
        r.ok = entries.length >= Number(a.count || 0);
        r.detail = `${entries.length} requests`;
      } else {
        r.detail = `unknown assertion type: ${a.type}`;
      }
    } catch (e) {
      r.detail = String(e && e.message ? e.message : e);
    }
    if (r.ok) passed++; else failed++;
    results.push(r);
  }
  return { passed, failed, results, pass_rate: assertions && assertions.length ? passed / assertions.length : 1 };
}
